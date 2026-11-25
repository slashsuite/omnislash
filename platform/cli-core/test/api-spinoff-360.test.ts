// ob 360 -- `ob spinoff` from anywhere the laptop is: the QUEUE half over the API, the LAUNCH half here.
//
// Two things are worth pinning and they pull in opposite directions, so both are asserted:
//
//   the queue half REACHES the API. A drain claims and stamps over HTTP, an enqueue posts a row, and a
//   listing reads one. If any of that quietly stopped happening, `ob spinoff` at the office would go back
//   to being a command that refuses.
//
//   the local half still refuses WHEN IT GENUINELY CANNOT RUN, and its refusal names THIS MACHINE. The bug
//   ob 360 fixes was a message, not a mechanism: "run it on the machine that has both the checkouts and the
//   database: the API host" sent the owner to the one machine with none of his checkouts. A
//   refusal that misdirects is worse than none, so the wording is a test, not a comment.
//
// The client half runs against a STUBBED transport (no network, no token file, no database). The server
// half runs against a REAL Postgres store through the ob 325 harness, because ob 308's claim is the one
// property that only a real database can demonstrate: two drains asking for one row get one row.
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { freshDbPath, psTable, runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_LOCAL_ONLY, OB_API_PREFIX, OB_API_ROUTES } from "../../../apps/cli/src/api/contract.ts";
import { API_ROUTED_COMMANDS, LOCAL_ONLY_COMMANDS, localOnlyRefusal } from "../../../apps/cli/src/api/routing.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { SPINOFF_WATCH_REFUSAL } from "../../../apps/cli/src/api/spinoff-client.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { __setSh, listSpinoffs } from "../../cli-coord/src/commands/spinoff.ts";
import { __setT3Seam, worktreeRepoOf } from "../../../apps/cli/src/t3/dispatch.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { FAKE_EFFORT_OPTIONS, installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const BUDGET = spawnBudget(4);

interface Stub {
  transport: ApiTransport;
  calls: ApiRequest[];
  bodies: Array<Record<string, unknown>>;
}

/** A transport that answers from a canned table, keyed `METHOD /path`, and records every request. */
function stub(answers: Record<string, unknown>): Stub {
  const calls: ApiRequest[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const transport: ApiTransport = async (req) => {
    calls.push(req);
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    bodies.push(body);
    const path = req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!;
    const key = `${req.method} ${path}`;
    if (!(key in answers)) {
      return { status: 404, body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }) };
    }
    const answer = answers[key];
    const resolved = typeof answer === "function" ? (answer as (b: Record<string, unknown>, r: ApiRequest) => unknown)(body, req) : answer;
    return { status: 200, body: JSON.stringify(resolved) };
  };
  return { transport, calls, bodies };
}

function api(s: Stub) {
  return { api: { base: BASE, token: TOKEN, transport: s.transport } };
}

/** The `GET /spinoffs/config` answer: enough config for the launch cores, nothing about a real machine. */
function configAnswer(over: Record<string, unknown> = {}) {
  return {
    config: {
      repo_checkouts: {},
      launcher: "t3",
      launcher_by_repo: {},
      engine: "claude",
      ...over,
    },
  };
}

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    ticket_ref: "360",
    repo: "/tmp/omnislash-fake-repo",
    branch: "build-360",
    worktree: "/tmp/omnislash-fake-worktree",
    mode: "agent",
    brief: "do the thing",
    status: "pending",
    error: null,
    agent_id: null,
    request_at: "2026-08-19T00:00:00.000Z",
    launched_at: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    total_tokens: null,
    base_sha: null,
    reported_at: null,
    launcher: null,
    launch_attempts: null,
    session_id: null,
    ...over,
  };
}

function launchable(rows: unknown[], over: Record<string, unknown> = {}) {
  return { active: 0, rows, remaining_pending: rows.length, ...over };
}

/**
 * A checkout whose `origin/main` carries `subject`. No network, no local `main` fast-forward.
 *
 * Returns the `base` commit too — the one before `subject` — because a spinoff row's `base_sha` has to be
 * locatable in this log to be ordered against (1201): a placeholder like `"abc"` is on no history, and a
 * row whose recorded start cannot be found is (correctly) not retired by a commit naming it.
 */
function gitWithOriginMain(subject: string): { repo: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "ob-937-"));
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
    return new TextDecoder().decode(p.stdout).trim();
  };
  run("init", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  run("commit", "--allow-empty", "-m", "init");
  const base = run("rev-parse", "HEAD");
  run("commit", "--allow-empty", "-m", subject);
  run("update-ref", "refs/remotes/origin/main", "HEAD");
  return { repo: dir, base };
}

/** A `sh` stub: `ps` answers a table with only this process in it, git answers a sha, nothing spawns. */
function shStub(psRunning: string[] = []) {
  return (cmd: string[]) => {
    if (cmd[0] === "ps") {
      const lines = ["    1 /sbin/launchd", ...psRunning.map((c, i) => `${90_000 + i} ${c}`), `${process.pid} ${process.execPath}`];
      return { ok: true, err: "", out: `${lines.join("\n")}\n` };
    }
    return { ok: true, err: "", out: "abc123\n" };
  };
}

const liveThread = (threadId: string) => ({
  thread: { threadId, projectId: "p", title: "architect", status: "idle" as const, worktreePath: null, branch: null, settled: false, archived: false, model: "m", providerInstanceId: "opencode", activeRunId: null, latestRunId: null },
  recentRuns: [],
  items: [],
  nextPosition: 0,
  hasMore: false,
});
/** The checkout `ob t3 architect` opens a new thread in: the cwd's, as a worktree's main checkout (OB-2255). */
const CWD_REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());
const OMNISLASH_PROJECT = { id: "omnislash", name: "omnislash", kind: "side", git_remote: null, created_at: "x", key: "OB", icon: null, display_name: null, stage: null, team_name: "omnislash" };
const OMNISLASH_TEAM = { name: "omnislash", icon: "🚌", display_name: "OmniSlash", created_at: "x", members: ["omnislash"], threads: [] };

describe("the classification, which was the bug (360)", () => {
  test("`spinoff` is ROUTED, not local-only, and it has a client handler", () => {
    expect(API_ROUTED_COMMANDS.has("spinoff")).toBe(true);
    expect(LOCAL_ONLY_COMMANDS.has("spinoff")).toBe(false);
    expect(typeof API_HANDLERS.spinoff).toBe("function");
    // The server's own local-only list must agree: a `POST /spinoffs` that came back as "this command is
    // deliberately not served" would be the two ends telling different stories about the same command.
    expect(OB_API_LOCAL_ONLY.spinoff).toBeUndefined();
  });

  test("`t3` is ROUTED too (1120): doctor/login run here, the team and its role rows are served", () => {
    // 1102 classified the whole command local-only, which was right while it was only doctor/login. 1120
    // gives it a database half (a registry row), so it moves to SPLIT with a handler: the handler itself
    // runs doctor/login here and crosses the wire only for the team and its rows (OB-2255).
    expect(API_ROUTED_COMMANDS.has("t3")).toBe(true);
    expect(LOCAL_ONLY_COMMANDS.has("t3")).toBe(false);
    expect(typeof API_HANDLERS.t3).toBe("function");
    expect(OB_API_LOCAL_ONLY.t3).toBeUndefined();
  });

  test("`ob t3 architect` on a client: the thread is opened HERE, the team and the registry row go over the API (1120, OB-2255)", async () => {
    const repo = CWD_REPO;
    const launched: Array<Record<string, unknown>> = [];
    const registered: Array<Record<string, unknown>> = [];
    const pinned: string[] = [];
    const restoreSeam = __setT3Seam({
      projects: async () => [{ id: "p", title: "omnislash", workspaceRoot: repo, defaultModelSelection: { instanceId: "opencode", model: "m" }, deletedAt: null }],
      capabilities: async () => ({ runtimeMode: "full-access", providers: [{ providerInstanceId: "opencode", displayName: "OpenCode", models: [{ id: "m" }, { id: "claude-sonnet-5-5" }], constraints: [] }] }),
      list: async () => ({ projectId: "p", threads: [], nextCursor: null }),
      // OB-2128: the only read is the check of the thread the launch returned
      read: async (threadId: string) => {
        if (threadId !== "t3-plan") throw new Error("no thread recorded yet");
        return liveThread(threadId);
      },
      launch: async (input) => {
        launched.push(input as unknown as Record<string, unknown>);
        return { threadId: "t3-plan", projectId: "p", modelSelection: input.modelSelection, runId: null, status: "idle" };
      },
      rename: async () => {},
      settle: async () => {},
      send: async () => {},
      wait: async () => ({ runId: null, status: "idle", timedOut: false }),
      // 1205: an empty architect queue, nothing held for a land to withdraw.
      queue: async () => ({ items: [], complete: true }),
      pin: async (id) => {
        pinned.push(id);
      },
      unpin: async () => {},
      disableAutoSettle: async () => {},
      queueCancel: async () => {},
      interrupt: async () => {},
    });
    try {
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /teams/omnislash": { team: OMNISLASH_TEAM },
        // `all=1`: an idle architect's row expires, and the thread id it carries is the whole idempotency.
        "GET /agents": { agents: [] },
        "POST /agents": (body: Record<string, unknown>) => {
          registered.push(body);
          return { agent: null, found: true, ticket_lease: null, released: [] };
        },
      });
      const r = await runCli(freshDbPath(), ["t3", "architect", "omnislash"], api(s));
      expect(r.code).toBe(0);
      expect(launched).toHaveLength(1);
      // the title's icon and display name come from the team, read over the API
      expect(launched[0]!.title).toBe("🚌 OmniSlash · architect");
      expect(String(launched[0]!.message).split("\n")[0]).toBe("/ob-architect"); // seeded with its role, orient-only
      expect(launched[0]!.workspaceStrategy).toEqual({ type: "root" });
      // TWO writes: the marker the command lays down BEFORE it launches (launcher `t3`, no thread id yet,
      // what a crashed creation leaves behind and what the next call refuses on), then the row with the id.
      expect(registered[0]).toMatchObject({ action: "register", id: "architect-omnislash", launcher: "t3", status: "planning", session_id: null, no_lease: true });
      expect(registered[1]).toMatchObject({ action: "register", id: "architect-omnislash", launcher: "t3", status: "planning", run: null, session_id: "t3-plan", no_lease: true });
      // `all=true` on the READ (the register is the POST that follows it).
      expect(s.calls.map((c) => `${c.method} ${c.url.replace(BASE + OB_API_PREFIX, "")}`).filter((u) => u.includes("/agents"))).toEqual(["GET /agents?all=true", "POST /agents", "POST /agents"]);
      expect(pinned).toEqual(["t3-plan"]);
      expect(r.out).toContain("omnislash architect created");
    } finally {
      restoreSeam();
    }
  });

  test("`ob t3 architect` when T3 refuses auto-settle: warning on stderr, exit 1, the architect still recorded (OB-1845)", async () => {
    const repo = CWD_REPO;
    const registered: Array<Record<string, unknown>> = [];
    const pinned: string[] = [];
    const restoreSeam = __setT3Seam({
      projects: async () => [{ id: "p", title: "omnislash", workspaceRoot: repo, defaultModelSelection: { instanceId: "opencode", model: "m" }, deletedAt: null }],
      capabilities: async () => ({ runtimeMode: "full-access", providers: [{ providerInstanceId: "opencode", displayName: "OpenCode", models: [{ id: "m" }, { id: "claude-sonnet-5-5" }], constraints: [] }] }),
      list: async () => ({ projectId: "p", threads: [], nextCursor: null }),
      // OB-2128: the only read is the check of the thread the launch returned
      read: async (threadId: string) => {
        if (threadId !== "t3-plan") throw new Error("no thread recorded yet");
        return liveThread(threadId);
      },
      launch: async (input) => ({ threadId: "t3-plan", projectId: "p", modelSelection: input.modelSelection, runId: null, status: "idle" }),
      rename: async () => {},
      pin: async (id) => {
        pinned.push(id);
      },
      unpin: async () => {},
      disableAutoSettle: async () => {
        throw new Error("the private route is gone");
      },
      settle: async () => {},
      send: async () => {},
      wait: async () => ({ runId: null, status: "idle", timedOut: false }),
      queue: async () => ({ items: [], complete: true }),
      queueCancel: async () => {},
      interrupt: async () => {},
    });
    try {
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /teams/omnislash": { team: OMNISLASH_TEAM },
        "GET /projects": { projects: [] },
        "GET /agents": { agents: [] },
        "POST /agents": (body: Record<string, unknown>) => {
          registered.push(body);
          return { agent: null, found: true, ticket_lease: null, released: [] };
        },
      });
      const r = await runCli(freshDbPath(), ["t3", "architect", "omnislash"], api(s));
      expect(r.code).toBe(1);
      expect(registered.at(-1)).toMatchObject({ session_id: "t3-plan" });
      expect(r.out).toContain("auto-settle NOT off");
      expect(r.err).toContain("auto-settle is still ON for team thread t3-plan");
      expect(r.err).toContain("Auto-settle behavior, Disabled");
    } finally {
      restoreSeam();
    }
  });

  test("the queue endpoints are declared, and none of them puts an id in a path", () => {
    const spinoffRoutes = OB_API_ROUTES.filter((r) => r.path.startsWith("/spinoffs"));
    expect(spinoffRoutes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /spinoffs",
      "GET /spinoffs/config",
      "POST /spinoffs",
      "POST /spinoffs/check",
      "POST /spinoffs/claim",
      "POST /spinoffs/cleanup-guard",
      "POST /spinoffs/land",
      "POST /spinoffs/launchable",
      "POST /spinoffs/note-error",
      "POST /spinoffs/overlap",
      "POST /spinoffs/phase",
      "POST /spinoffs/planned-files",
      "POST /spinoffs/ready",
      "POST /spinoffs/reclaim",
      "POST /spinoffs/reopen",
      "POST /spinoffs/resume",
      "POST /spinoffs/sendback",
      "POST /spinoffs/serving",
      "POST /spinoffs/stamp",
      "POST /spinoffs/tokens",
      "POST /spinoffs/trial",
      "POST /spinoffs/verdict",
    ]);
    for (const r of spinoffRoutes) expect(r.path).not.toContain(":");
  });
});

describe("the refusal names THIS machine, never the API host (360)", () => {
  test("`ob spinoff watch` refuses, says everything else works here, and reaches no HTTP", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["spinoff", "watch"], api(s));
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot run on this machine");
    expect(r.err).toContain("fs.watch");
    // What DOES work, and what to type instead: the part the old message got wrong.
    expect(r.err).toContain("EVERYTHING ELSE ABOUT 'ob spinoff' WORKS HERE");
    expect(r.err).toContain("ob spinoff reconcile");
    // The misdirection this ticket exists to delete.
    expect(r.err).not.toContain("API host");
    expect(r.err).not.toContain("the machine that has both the checkouts and the database");
    expect(s.calls).toEqual([]);
  });

  test("the watch refusal never points at the API host", () => {
    expect(SPINOFF_WATCH_REFUSAL).not.toContain("API host");
    expect(SPINOFF_WATCH_REFUSAL).toContain("this machine");
  });

  test("the generic local-only refusal is not reachable for spinoff any more", () => {
    // It still exists for host-only commands (web/backup/db/cert, 457). What must not happen again is
    // `spinoff` being routed through it.
    expect(localOnlyRefusal("web", "starts the dashboard on the API host", "api-host")).toContain("the API host");
    for (const [command] of LOCAL_ONLY_COMMANDS) expect(command).not.toBe("spinoff");
  });
});

describe("the queue half reaches the API (360)", () => {
  test("`ob spinoff list` reads the rows over HTTP and renders them like the local command", async () => {
    const s = stub({
      "GET /spinoffs": { spinoffs: [row({ status: "launched", launcher: "headless" })] },
      "GET /spinoffs/config": configAnswer(),
    });
    const r = await runCli(freshDbPath(), ["spinoff", "list"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("360");
    expect(r.out).toContain("build-360");
    expect(r.out).toContain("headless");
    expect(s.calls.some((c) => c.url.startsWith(`${BASE}${OB_API_PREFIX}/spinoffs`))).toBe(true);
    for (const c of s.calls) expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("`ob spinoff list --json` sets landed from ticket status and origin/main (937)", async () => {
    const { repo, base } = gitWithOriginMain("fix(ob 932): resume the architect");
    try {
      const s = stub({
        "GET /spinoffs": {
          spinoffs: [
            row({ id: 1, ticket_ref: "915", status: "launched", branch: "915", repo, base_sha: base }),
            row({ id: 2, ticket_ref: "917", status: "launched", branch: "917", repo, base_sha: base }),
            row({ id: 3, ticket_ref: "932", status: "launched", branch: "932", repo, base_sha: base }),
            row({ id: 4, ticket_ref: "918", status: "launched", branch: "918", repo, base_sha: base }),
          ],
        },
        "GET /spinoffs/config": configAnswer(),
        "GET /items": { items: [{ id: "915", status: "done" }] },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "list", "--json"], api(s));
      expect(r.code).toBe(0);
      const listed = JSON.parse(r.out) as Array<{ ticket_ref: string; landed: boolean }>;
      const landed = (ref: string) => listed.find((row) => row.ticket_ref === ref)?.landed;
      // Done, even with no commit naming it in this fixture's subject.
      expect(landed("915")).toBe(true);
      // Open, and origin/main does not name it.
      expect(landed("917")).toBe(false);
      expect(landed("918")).toBe(false);
      // Still open, but the squash on origin/main names it. Local main need not move.
      expect(landed("932")).toBe(true);
      expect(s.calls.some((c) => c.url.includes("/items?status=done"))).toBe(true);
      expect(s.calls.some((c) => c.url.includes("/items/"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, spawnBudget(8));

  test("a failed ticket read does not fail list --json; origin/main can still set landed (937)", async () => {
    const { repo, base } = gitWithOriginMain("fix(ob 932): resume the architect");
    try {
      const s = stub({
        "GET /spinoffs": { spinoffs: [row({ ticket_ref: "932", status: "launched", branch: "932", repo, base_sha: base })] },
        "GET /spinoffs/config": configAnswer(),
      });
      const r = await runCli(freshDbPath(), ["spinoff", "list", "--json"], api(s));
      expect(r.code).toBe(0);
      expect((JSON.parse(r.out) as Array<{ landed: boolean }>)[0]?.landed).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, spawnBudget(8));

  test("a non-json list does not fetch ticket status (937)", async () => {
    const s = stub({
      "GET /spinoffs": { spinoffs: [row({ status: "launched", ticket_ref: "915" })] },
      "GET /spinoffs/config": configAnswer(),
    });
    const r = await runCli(freshDbPath(), ["spinoff", "list"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls.some((c) => c.url.includes("/items"))).toBe(false);
  });

  test("`ob spinoff show` reads over HTTP and does not POST an enqueue", async () => {
    const s = stub({
      "GET /spinoffs": { spinoffs: [row({ id: 7, ticket_ref: "360", brief: "do the thing", status: "launched" })] },
      "GET /spinoffs/config": configAnswer(),
    });
    const r = await runCli(freshDbPath(), ["spinoff", "show", "360"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("do the thing");
    expect(r.out).toContain("360");
    expect(r.out).not.toContain("queued ");
    // OB-2131: the planned-files read is a POST only so the ref travels in a body (357); it enqueues nothing.
    expect(s.calls.filter((c) => c.method === "POST" && !c.url.endsWith("/spinoffs/planned-files"))).toEqual([]);
    expect(s.calls.some((c) => c.method === "GET" && c.url.startsWith(`${BASE}${OB_API_PREFIX}/spinoffs`))).toBe(true);
  });

  test("`ob spinoff <ticket>` posts the row, with the repo as a SLUG and the ticket's brief as the message", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ob-1162-repo-"));
    mkdirSync(join(repo, ".git"));
    const s = stub({
      // An explicit checkout mapping pins WHICH directory the brief is read from (and #217's slug).
      "GET /spinoffs/config": configAnswer({ repo_checkouts: { omnislash: repo } }),
      "POST /spinoffs": (body: Record<string, unknown>) => ({ row: row({ id: 11, ticket_ref: String(body.ticket_ref) }), deduped: false }),
    });
    const r = await runCli(freshDbPath(), ["spinoff", "queue", "360", "--repo", "omnislash"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("queued 360");
    const posted = s.bodies[s.calls.findIndex((c) => c.method === "POST")]!;
    expect(posted.repo).toBe("omnislash"); // a slug, not this machine's path (217)
    expect(posted.ticket_ref).toBe("360");
    expect(posted.mode).toBe("interactive");
    // No ticket file in that checkout and NO item behind the ref (the stub 404s the one item read, 1190)
    // → the pointer, unchanged (1162/563). The read was MADE: this is a fallthrough, not a skip.
    expect(String(posted.brief)).toBe(`Read 360's brief and implement per its acceptance criteria.`);
    expect(s.calls.some((c) => c.method === "GET" && c.url.endsWith("/items/360"))).toBe(true);
  });

  test("an item-only ref is composed from the item read over the API, not the pointer (1190)", async () => {
    // Thread 738 is the reference case: an ob ITEM with a body and no wayfinder file. A client has no
    // store, so the one read it makes is the same `GET /items/:id` `ob show <ref>` makes.
    const repo = mkdtempSync(join(tmpdir(), "ob-1190-repo-"));
    mkdirSync(join(repo, ".git"));
    const s = stub({
      "GET /spinoffs/config": configAnswer({ repo_checkouts: { omnislash: repo } }),
      "GET /items/738": { item: { id: "738", title: "An item-only brief", body: "The item's own body." } },
      "POST /spinoffs": (body: Record<string, unknown>) => ({ row: row({ id: 13, ticket_ref: String(body.ticket_ref) }), deduped: false }),
    });
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "queue", "738", "--repo", "omnislash"], api(s));
      expect(r.code).toBe(0);
      const posted = s.bodies[s.calls.findIndex((c) => c.method === "POST")]!;
      const brief = String(posted.brief);
      expect(brief.split("\n\n")[0]).toBe("738 · An item-only brief");
      expect(brief).toContain("The item's own body.");
      expect(brief).toContain("Run the `ob-spinoff` skill now");
      expect(brief).not.toContain(`Read 738's brief`);
      // ONE read, for this ref and no other
      expect(s.calls.filter((c) => c.method === "GET" && c.url.includes("/items/"))).toHaveLength(1);
      // and the client's dry run prints exactly what it would post
      const dry = await runCli(freshDbPath(), ["spinoff", "brief", "738", "--repo", "omnislash"], api(s));
      expect(dry.code).toBe(0);
      expect(dry.out.trimEnd()).toBe(brief);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a ref that collides with an item's id is bound to the path, and SAID so over the API too (1226)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ob-1226-repo-"));
    mkdirSync(join(repo, ".git"));
    const s = stub({
      "GET /spinoffs/config": configAnswer({ repo_checkouts: { omnislash: repo } }),
      // the fly in the ointment: an ITEM whose id is the ref, while the row the server wrote serves item
      // 1135 (wayfinder 1133's mirror). The SERVER resolves that where the store is and says so on the
      // enqueue it already answers — the client needs no read of its own (and no id in a url, 357).
      "GET /items/1133": { item: { id: "1133", title: "S2 · the strip", body: null } },
      "POST /spinoffs": (body: Record<string, unknown>) => ({
        row: row({ id: 16, ticket_ref: String(body.ticket_ref), item_id: "1135" }),
        deduped: false,
        collision: "1133",
      }),
    });
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "queue", "1133", "--repo", "omnislash"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("queued 1133");
      expect(r.err).toContain("both item 1133's id and the ticket path item 1135 names");
      expect(r.err).toContain("bound to 1135");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a ref that IS its own item says nothing: the ordinary dispatch is unchanged (1226)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ob-1226-plain-"));
    mkdirSync(join(repo, ".git"));
    const s = stub({
      "GET /spinoffs/config": configAnswer({ repo_checkouts: { omnislash: repo } }),
      "GET /items/360": { item: { id: "360", title: "Its own item", body: "Body." } },
      "GET /projects": { projects: [] }, // OB-2103: the launch message's stage read
      "POST /spinoffs": (body: Record<string, unknown>) => ({
        row: row({ id: 17, ticket_ref: String(body.ticket_ref), item_id: "360" }),
        deduped: false,
        collision: null,
      }),
    });
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "queue", "360", "--repo", "omnislash"], api(s));
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a ticket file wins over the item, and costs no item read (1190)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ob-1190-file-"));
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "wayfinder", "tickets"), { recursive: true });
    writeFileSync(
      join(repo, "wayfinder", "tickets", "738-brief.md"),
      "---\ntitle: The file wins\n---\n\n## What to build\n\nRead this, not the item.\n",
    );
    const s = stub({
      "GET /spinoffs/config": configAnswer({ repo_checkouts: { omnislash: repo } }),
      "GET /items/738": { item: { id: "738", title: "The item", body: "Not this." } },
      "POST /spinoffs": (body: Record<string, unknown>) => ({ row: row({ id: 14, ticket_ref: String(body.ticket_ref) }), deduped: false }),
    });
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "queue", "738", "--repo", "omnislash"], api(s));
      expect(r.code).toBe(0);
      const posted = s.bodies[s.calls.findIndex((c) => c.method === "POST")]!;
      const brief = String(posted.brief);
      expect(brief.split("\n\n")[0]).toBe("738 · The file wins");
      expect(brief).toContain("Read this, not the item.");
      expect(brief).not.toContain("Not this.");
      expect(s.calls.some((c) => c.method === "GET" && c.url.includes("/items/"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a failed item read falls through to the pointer; the dispatch still happens (1190)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ob-1190-down-"));
    mkdirSync(join(repo, ".git"));
    const s = stub({
      "GET /spinoffs/config": configAnswer({ repo_checkouts: { omnislash: repo } }),
      "POST /spinoffs": (body: Record<string, unknown>) => ({ row: row({ id: 15, ticket_ref: String(body.ticket_ref) }), deduped: false }),
    });
    // The item endpoint is broken, not missing: a 500 is a failed read, and a brief never fails a dispatch.
    const transport: ApiTransport = async (req) => {
      if (req.url.includes("/items/738")) {
        return { status: 500, body: JSON.stringify({ error: { message: "the tracker is down" } }) };
      }
      return s.transport(req);
    };
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "queue", "738", "--repo", "omnislash"], {
        api: { base: BASE, token: TOKEN, transport },
      });
      expect(r.code).toBe(0);
      expect(r.err).toContain("could not read ob item 738");
      const posted = s.bodies[s.calls.findIndex((c) => c.method === "POST")]!;
      expect(String(posted.brief)).toBe(`Read 738's brief and implement per its acceptance criteria.`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the ticket's own brief is composed HERE, off the checkout, and crosses the wire as the message (1162)", async () => {
    // The FILE is the only work order a client can read without a tracker round-trip, and it lives on
    // this machine — so the client composes and the row carries the result (the API host has no checkout).
    const repo = mkdtempSync(join(tmpdir(), "ob-1162-repo-"));
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "wayfinder", "tickets"), { recursive: true });
    writeFileSync(
      join(repo, "wayfinder", "tickets", "1162-thread-brief.md"),
      [
        "---",
        'title: "A spinoff thread opens with its brief"',
        "---",
        "",
        "## What to build",
        "",
        "Compose the launch message from the ticket.",
        "",
        "## Acceptance",
        "",
        "- the first message IS the brief",
        "",
        "## Work log",
        "",
        "- the record",
        "",
      ].join("\n"),
    );
    const s = stub({
      "GET /spinoffs/config": configAnswer({ repo_checkouts: { omnislash: repo } }),
      "POST /spinoffs": (body: Record<string, unknown>) => ({ row: row({ id: 12, ticket_ref: String(body.ticket_ref) }), deduped: false }),
    });
    const r = await runCli(freshDbPath(), ["spinoff", "queue", "1162", "--repo", "omnislash"], api(s));
    expect(r.code).toBe(0);
    const posted = s.bodies[s.calls.findIndex((c) => c.method === "POST")]!;
    const brief = String(posted.brief);
    expect(posted.repo).toBe("omnislash");
    expect(brief.startsWith("1162 · A spinoff thread opens with its brief")).toBe(true);
    expect(brief).toContain("## What to build\n\nCompose the launch message from the ticket.");
    expect(brief).toContain("## Acceptance\n\n- the first message IS the brief");
    expect(brief).not.toContain("## Work log");
    expect(brief).toContain("Run the `ob-spinoff` skill now");
    // and the client's dry run prints exactly what it posted
    const dry = await runCli(freshDbPath(), ["spinoff", "brief", "1162", "--repo", "omnislash"], api(s));
    expect(dry.code).toBe(0);
    expect(dry.out.trimEnd()).toBe(brief);
  });

  test("a `#<issue>` ref refuses by name rather than queueing a guessed branch", async () => {
    const s = stub({ "GET /spinoffs/config": configAnswer() });
    const r = await runCli(freshDbPath(), ["spinoff", "#42"], api(s));
    expect(r.code).toBe(1);
    expect(r.err).toContain("GitHub credential");
    expect(s.calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});

describe("`ob spinoff <ref>` over the API launches in the same invocation (1589)", () => {
  /** One repo, its worktree, a fake T3 with a project for the repo, and a stub that runs the whole path. */
  function immediate(leases: unknown[] = [], modelOptions: Record<string, typeof FAKE_EFFORT_OPTIONS> = {}, rowOver: Record<string, unknown> = {}) {
    const repo = mkdtempSync(join(tmpdir(), "ob-1589-repo-"));
    mkdirSync(join(repo, ".git"));
    const worktree = `${repo}.1589`;
    mkdirSync(worktree, { recursive: true });
    const pending = row({ launcher: "t3", worktree, repo, ticket_ref: "1589", branch: "1589", ...rowOver });
    const s = stub({
      "GET /spinoffs/config": configAnswer({ repo_checkouts: { omnislash: repo } }),
      "GET /leases": { leases },
      "POST /spinoffs": { row: pending, deduped: false },
      "POST /spinoffs/launchable": launchable([{ row: pending, tags: [], hold: null }]),
      "POST /spinoffs/claim": { claimed: { ...pending, status: "launching" }, error: null },
      "POST /spinoffs/stamp": (body: Record<string, unknown>) => ({ id: body.id, outcome: body.outcome }),
      // OB-1991: no model trial is active, so the dispatch is a single build
      "POST /spinoffs/trial": { op: "plan", plan: null },
    });
    const restoreSh = __setSh(shStub());
    const t3 = installFakeT3([repo], undefined, modelOptions);
    return {
      s,
      t3,
      worktree,
      done: () => {
        t3.restore();
        restoreSh();
        rmSync(repo, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
      },
    };
  }

  const foreign = { resource: "ticket:1589", holder: "architect-other", acquired_at: "2026-10-21T00:00:00.000Z", ttl_s: 1800, heartbeat_at: "2026-10-21T00:00:00.000Z", expired: false };

  test("claim on the server, launch here, stamp on the server: the thread id is stamped and printed", async () => {
    const h = immediate();
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "1589", "--repo", "omnislash", "--worktree", h.worktree], api(h.s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("T3 thread t3-1");
      expect(h.t3.launches).toHaveLength(1);
      const order = h.s.calls.filter((c) => c.method === "POST").map((c) => c.url.slice((BASE + OB_API_PREFIX).length));
      // OS-47: the overlap read sits between the enqueue and the launch; it warns, never refuses.
      expect(order).toEqual(["/spinoffs/trial", "/spinoffs", "/spinoffs/overlap", "/spinoffs/launchable", "/spinoffs/claim", "/spinoffs/stamp"]);
      const stampBody = h.s.bodies[h.s.calls.findIndex((c) => c.url.endsWith("/spinoffs/stamp"))]!;
      expect(stampBody.outcome).toBe("launched");
      expect(stampBody.launcher).toBe("t3");
      expect(stampBody.t3_thread_id).toBe("t3-1");
    } finally {
      h.done();
    }
  });

  test("--effort crosses the wire on the enqueue and the stamp, and the launch carries the option (OB-1815)", async () => {
    // the server stores the level on the row it returns, as the real one does
    const h = immediate([], { "claude-sonnet-5-5": FAKE_EFFORT_OPTIONS }, { effort: "xhigh" });
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "1589", "--repo", "omnislash", "--worktree", h.worktree, "--effort", "xhigh"], api(h.s));
      expect(r.code).toBe(0);
      expect(h.t3.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5", options: [{ id: "effort", value: "xhigh" }] });
      const bodyOf = (suffix: string) => h.s.bodies[h.s.calls.findIndex((c) => c.method === "POST" && c.url.endsWith(suffix))]!;
      expect(bodyOf("/spinoffs").effort).toBe("xhigh");
      expect(bodyOf("/spinoffs/stamp").effort).toBe("xhigh");
    } finally {
      h.done();
    }
  });

  test("no --effort sends none on the enqueue and stamps the model's default (OB-1815)", async () => {
    const h = immediate([], { "claude-sonnet-5-5": FAKE_EFFORT_OPTIONS });
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "1589", "--repo", "omnislash", "--worktree", h.worktree], api(h.s));
      expect(r.code).toBe(0);
      expect("options" in h.t3.launches[0]!.modelSelection).toBe(false);
      const bodyOf = (suffix: string) => h.s.bodies[h.s.calls.findIndex((c) => c.method === "POST" && c.url.endsWith(suffix))]!;
      expect(bodyOf("/spinoffs").effort ?? null).toBeNull();
      expect(bodyOf("/spinoffs/stamp").effort).toBe("default (high)");
    } finally {
      h.done();
    }
  });

  test("--effort the model does not list is refused by name before anything is queued (OB-1815)", async () => {
    const h = immediate([], { "claude-sonnet-5-5": FAKE_EFFORT_OPTIONS });
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "1589", "--repo", "omnislash", "--worktree", h.worktree, "--effort", "max"], api(h.s));
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("does not list effort 'max'");
      expect(r.err).toContain("Nothing was queued");
      expect(h.s.calls.filter((c) => c.method === "POST")).toEqual([]);
      expect(h.t3.launches).toEqual([]);
    } finally {
      h.done();
    }
  });

  test("--effort high on Opus is refused before anything is queued, naming --opus-high (OB-2107)", async () => {
    const h = immediate([], { "claude-opus-5-5": FAKE_EFFORT_OPTIONS });
    try {
      for (const effort of ["high", "xhigh", "max"]) {
        const r = await runCli(freshDbPath(), ["spinoff", "1589", "--repo", "omnislash", "--worktree", h.worktree, "--tier", "complex", "--effort", effort], api(h.s));
        expect(r.code).not.toBe(0);
        expect(r.err).toContain("--opus-high");
        expect(r.err).toContain("Nothing was queued");
      }
      expect(h.s.calls.filter((c) => c.method === "POST")).toEqual([]);
      expect(h.t3.launches).toEqual([]);
    } finally {
      h.done();
    }
  });

  test("--opus-high '<his ask>' lets Opus run on high, and the quote rides on the enqueue's note (OB-2107)", async () => {
    const h = immediate([], { "claude-opus-5-5": FAKE_EFFORT_OPTIONS }, { effort: "high", tier: "complex" });
    try {
      const argv = ["spinoff", "1589", "--repo", "omnislash", "--worktree", h.worktree, "--tier", "complex", "--effort", "high", "--opus-high", "high for this one"];
      const r = await runCli(freshDbPath(), argv, api(h.s));
      expect(r.code).toBe(0);
      expect(h.t3.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] });
      const enqueue = h.s.bodies[h.s.calls.findIndex((c) => c.method === "POST" && c.url.endsWith("/spinoffs"))]!;
      expect(enqueue.note).toBe(`opus-high on the owner's ask: "high for this one"`);
    } finally {
      h.done();
    }
  });

  test("`spinoff queue` over the API runs the Opus-high check too: nothing is posted without the ask (OB-2107)", async () => {
    const h = immediate();
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "queue", "1589", "--repo", "omnislash", "--tier", "complex", "--effort", "high"], api(h.s));
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("--opus-high");
      expect(h.s.calls.filter((c) => c.method === "POST")).toEqual([]);
      const asked = await runCli(freshDbPath(), ["spinoff", "queue", "1589", "--repo", "omnislash", "--tier", "complex", "--effort", "high", "--opus-high", "queue it high"], api(h.s));
      expect(asked.code).toBe(0);
      const enqueue = h.s.bodies[h.s.calls.findIndex((c) => c.method === "POST" && c.url.endsWith("/spinoffs"))]!;
      expect(enqueue.note).toBe(`opus-high on the owner's ask: "queue it high"`);
    } finally {
      h.done();
    }
  });

  test("a foreign hold is refused by name, exits non-zero, and nothing is queued", async () => {
    const h = immediate([foreign]);
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "1589", "--repo", "omnislash", "--worktree", h.worktree], api(h.s));
      expect(r.code).toBe(1);
      expect(r.err).toContain("architect-other");
      expect(r.err).toContain("Nothing was queued");
      expect(h.s.calls.filter((c) => c.method === "POST")).toEqual([]);
      expect(h.t3.launches).toEqual([]);
    } finally {
      h.done();
    }
  });

  test("`--holder` naming that hold dispatches under it", async () => {
    const h = immediate([foreign]);
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "1589", "--repo", "omnislash", "--worktree", h.worktree, "--holder", "architect-other"], api(h.s));
      expect(r.code).toBe(0);
      expect(h.t3.launches).toHaveLength(1);
    } finally {
      h.done();
    }
  });
});

describe("the drain: the claim crosses the wire, the launch stays here (360, keeping 191 + 308)", () => {
  test("a launchable row is claimed over the API, launched locally, then stamped -- and no id is in a url", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "ob-360-wt-"));
    const restoreSh = __setSh(shStub());
    const t3 = installFakeT3([worktree]);
    try {
      const pending = row({ launcher: "t3", worktree, repo: worktree });
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": { spinoffs: [] },
        "POST /spinoffs/reclaim": { reclaimed: [] },
        "POST /spinoffs/launchable": launchable([{ row: pending, tags: [], hold: null }]),
        "POST /spinoffs/claim": { claimed: { ...pending, status: "launching" }, error: null },
        "POST /spinoffs/stamp": (body: Record<string, unknown>) => ({ id: body.id, outcome: body.outcome }),
      });
      const r = await runCli(freshDbPath(), ["spinoff", "drain", "--all"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("launched 1");

      // The launch happened HERE: this machine's T3 opened a thread bound to the worktree on this disk.
      expect(t3.launches).toHaveLength(1);
      expect(t3.launches[0]!.workspaceStrategy).toMatchObject({ type: "existing_worktree", worktreePath: worktree });

      // 191's order: the claim comes BEFORE the stamp, because the claim is the exclusion.
      const order = s.calls.map((c) => c.url.slice((BASE + OB_API_PREFIX).length));
      expect(order.indexOf("/spinoffs/claim")).toBeLessThan(order.indexOf("/spinoffs/stamp"));

      const claimBody = s.bodies[s.calls.findIndex((c) => c.url.endsWith("/spinoffs/claim"))]!;
      expect(claimBody.id).toBe(7);
      const stampBody = s.bodies[s.calls.findIndex((c) => c.url.endsWith("/spinoffs/stamp"))]!;
      expect(stampBody.outcome).toBe("launched");
      expect(stampBody.worktree).toBe(worktree);
      expect(stampBody.launcher).toBe("t3");
      expect(stampBody.t3_thread_id).toBe("t3-1");
      expect(stampBody.engine).toBe("claude"); // the engine stamps too, or reconcile reads the wrong transcript source

      // 357's rule, applied to this family: a row id never appears in a url, only in a body.
      for (const c of s.calls) expect(c.url).not.toContain("/spinoffs/7");
      for (const c of s.calls) expect(c.url.split("?")[0]!.endsWith("/7")).toBe(false);
    } finally {
      t3.restore();
      restoreSh();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("a `t3` row is launched HERE too: the thread opens locally and its ids cross in the stamp (1120)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ob-1120-repo-"));
    const worktree = `${repo}.1120`;
    mkdirSync(worktree, { recursive: true });
    const launched: Array<Record<string, unknown>> = [];
    const restoreSh = __setSh(shStub());
    // A fake T3: enough of the seam for the launch half (project, catalog, list, read, launch).
    const restoreSeam = __setT3Seam({
      projects: async () => [{ id: "p", title: "omnislash", workspaceRoot: repo, defaultModelSelection: { instanceId: "opencode", model: "m" }, deletedAt: null }],
      capabilities: async () => ({ runtimeMode: "full-access", providers: [{ providerInstanceId: "opencode", displayName: "OpenCode", models: [{ id: "m" }, { id: "claude-sonnet-5-5" }], constraints: [] }] }),
      list: async () => ({ projectId: "p", threads: [], nextCursor: null }),
      read: async (threadId: string) => {
        throw new Error(`nothing to read (${threadId})`);
      },
      launch: async (input) => {
        launched.push(input as unknown as Record<string, unknown>);
        return { threadId: "t3-1", projectId: "p", modelSelection: input.modelSelection, runId: "run-1", status: "running" };
      },
      rename: async () => {},
      settle: async () => {},
      send: async () => {},
      wait: async () => ({ runId: null, status: "idle", timedOut: false }),
      // 1205: an empty architect queue, nothing held for a land to withdraw.
      queue: async () => ({ items: [], complete: true }),
      pin: async (id) => {
        throw new Error(`pin ${id}: only a group thread is pinned (OB-2251), never an architect (OB-2122)`);
      },
      unpin: async () => {},
      disableAutoSettle: async () => {},
      queueCancel: async () => {},
      interrupt: async () => {},
    });
    try {
      const pending = row({ launcher: "t3", worktree, repo });
      const s = stub({
        "GET /spinoffs/config": configAnswer({ launcher: "t3" }),
        "GET /spinoffs": { spinoffs: [] },
        "POST /spinoffs/reclaim": { reclaimed: [] },
        "POST /spinoffs/launchable": launchable([{ row: pending, tags: [], hold: null, ticket_title: "The name the host read" }]),
        "POST /spinoffs/claim": { claimed: { ...pending, status: "launching" }, error: null },
        "POST /spinoffs/stamp": (body: Record<string, unknown>) => ({ id: body.id, outcome: body.outcome }),
      });
      const r = await runCli(freshDbPath(), ["spinoff", "drain", "--all"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("launched 1");

      // The thread was opened on THIS machine's T3, bound to the row's ob-owned worktree.
      expect(launched).toHaveLength(1);
      expect(launched[0]!.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: worktree, branch: "build-360" });
      expect(launched[0]!.clientRequestId).toBe("ob-spinoff-7");
      // 1143: the HOST read the ticket's title (the client has no store), and the thread wears it.
      expect(launched[0]!.title).toBe("360 · The name the host read");

      // The ids travel with the stamp: the row is what reconcile and the cleanup guard read.
      const stampBody = s.bodies[s.calls.findIndex((c) => c.url.endsWith("/spinoffs/stamp"))]!;
      expect(stampBody.outcome).toBe("launched");
      expect(stampBody.launcher).toBe("t3");
      expect(stampBody.t3_thread_id).toBe("t3-1");
      expect(stampBody.t3_run_id).toBe("run-1");
      // 1480: an untiered row launches at medium, on the project's instance, and the model crosses in the stamp.
      expect(launched[0]!.modelSelection).toEqual({ instanceId: "opencode", model: "claude-sonnet-5-5" });
      expect(stampBody.model).toBe("claude-sonnet-5-5");
    } finally {
      restoreSeam();
      restoreSh();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a row a live foreign session holds stays PENDING and is reported: it is never claimed", async () => {
    const s = stub({
      "GET /spinoffs/config": configAnswer(),
      "GET /spinoffs": { spinoffs: [] },
      "POST /spinoffs/reclaim": { reclaimed: [] },
      "POST /spinoffs/launchable": launchable([
        { row: row(), tags: [], hold: { resource: "ticket:360", holder: "architect-omnislash" } },
      ]),
    });
    const r = await runCli(freshDbPath(), ["spinoff", "drain", "--all"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("left queued, ticket:360 held by architect-omnislash");
    expect(s.calls.some((c) => c.url.endsWith("/spinoffs/claim"))).toBe(false);
  });

  test("a row recorded under a RETIRED launcher still LAUNCHES -- a warning, never a wait (ob 1109)", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "ob-360-legacy-wt-"));
    const restoreSh = __setSh(shStub());
    const t3 = installFakeT3([worktree]);
    try {
      // `warp` is a real recorded legacy value (as is `headless`, ob 1589): launcherNameFrom must
      // warn-and-fall-back to t3, never leave the row pending on a launcher that no longer exists.
      const pending = row({ launcher: "warp", worktree, repo: worktree });
      const s = stub({
        "GET /spinoffs/config": configAnswer({ launcher: "warp" }),
        "GET /spinoffs": { spinoffs: [] },
        "POST /spinoffs/reclaim": { reclaimed: [] },
        "POST /spinoffs/launchable": launchable([{ row: pending, tags: [], hold: null }]),
        "POST /spinoffs/claim": { claimed: { ...pending, status: "launching" }, error: null },
        "POST /spinoffs/stamp": (body: Record<string, unknown>) => ({ id: body.id, outcome: body.outcome }),
      });
      const r = await runCli(freshDbPath(), ["spinoff", "drain", "--all"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("launched 1");
      expect(r.out).not.toContain("left queued");
      expect(t3.launches).toHaveLength(1); // launched HERE, not deferred
      expect(s.calls.some((c) => c.url.endsWith("/spinoffs/claim"))).toBe(true);
    } finally {
      t3.restore();
      restoreSh();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("a launch that happened whose STAMP did not is reported with the command that finishes it (191)", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "ob-360-wt-"));
    const restoreSh = __setSh(shStub());
    const t3 = installFakeT3([worktree]);
    try {
      const pending = row({ launcher: "t3", worktree, repo: worktree });
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": { spinoffs: [] },
        "POST /spinoffs/reclaim": { reclaimed: [] },
        "POST /spinoffs/launchable": launchable([{ row: pending, tags: [], hold: null }]),
        "POST /spinoffs/claim": { claimed: { ...pending, status: "launching" }, error: null },
        // no stub for the stamp: the endpoint answers 404, which is what an unreachable half looks like
      });
      const r = await runCli(freshDbPath(), ["spinoff", "drain", "--all"], api(s));
      expect(r.code).toBe(1);
      expect(r.err).toContain("NOT RECORDED");
      expect(r.err).toContain("LAUNCHED here");
      expect(r.err).toContain("ob spinoff stamp --id 7 --outcome launched");
      expect(r.err).toContain("spinoff reclaim");
    } finally {
      t3.restore();
      restoreSh();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("OB-1796: the API drain launches only the named repo's row, and a refusal touches nothing", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ob-1796-")));
    const repoA = join(base, "A");
    const repoB = join(base, "B");
    for (const dir of [repoA, repoB]) mkdirSync(join(dir, ".git"), { recursive: true });
    const wtA = `${repoA}.build-a`;
    mkdirSync(wtA, { recursive: true });
    const restoreSh = __setSh(shStub());
    const t3 = installFakeT3([repoA, repoB]);
    try {
      const a = row({ id: 1, ticket_ref: "A-1", launcher: "t3", worktree: wtA, repo: "A", branch: "build-a" });
      const b = row({ id: 2, ticket_ref: "B-1", launcher: "t3", worktree: `${repoB}.build-b`, repo: "B", branch: "build-b" });
      const answers = () => ({
        "GET /spinoffs/config": configAnswer({ repo_checkouts: { A: repoA, B: repoB } }),
        "GET /spinoffs": { spinoffs: [] },
        "POST /spinoffs/reclaim": { reclaimed: [] },
        "POST /spinoffs/launchable": launchable([{ row: a, tags: [], hold: null }, { row: b, tags: [], hold: null }]),
        "POST /spinoffs/claim": (body: Record<string, unknown>) => ({ claimed: { ...(body.id === 1 ? a : b), status: "launching" }, error: null }),
        "POST /spinoffs/stamp": (body: Record<string, unknown>) => ({ id: body.id, outcome: body.outcome }),
      });

      const scoped = stub(answers());
      const r = await runCli(freshDbPath(), ["spinoff", "drain", "--repo", "A"], api(scoped));
      expect(r.code).toBe(0);
      expect(r.out).toContain("launched 1");
      expect(r.out).toContain("B-1: skipped, queued for repo B, not A");
      const claimed = scoped.calls.flatMap((c, i) => (c.url.endsWith("/spinoffs/claim") ? [scoped.bodies[i]!.id] : []));
      expect(claimed).toEqual([1]); // B's row was never claimed

      // Outside any repo (and with no flag) the drain refuses before it asks the API to change anything.
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "ob-1796-out-")));
      const prev = process.cwd();
      process.chdir(outside);
      const refused = stub(answers());
      try {
        const nope = await runCli(freshDbPath(), ["spinoff", "drain"], api(refused));
        expect(nope.code).not.toBe(0);
        expect(nope.err).toContain("spinoff drain launched nothing");
      } finally {
        process.chdir(prev);
        rmSync(outside, { recursive: true, force: true });
      }
      for (const path of ["/spinoffs/reclaim", "/spinoffs/launchable", "/spinoffs/claim", "/spinoffs/stamp"]) {
        expect(refused.calls.some((c) => c.url.includes(path))).toBe(false);
      }
    } finally {
      t3.restore();
      restoreSh();
      rmSync(base, { recursive: true, force: true });
      rmSync(wtA, { recursive: true, force: true });
    }
  });

  test("an unreachable API stops the sweep before it touches this disk", async () => {
    const s = stub({ "GET /spinoffs/config": configAnswer() }); // reclaim/launchable both 404
    const r = await runCli(freshDbPath(), ["spinoff", "drain", "--all"], api(s));
    expect(r.code).toBe(1);
    expect(r.err).toContain("the drain stopped");
    expect(s.calls.some((c) => c.url.endsWith("/spinoffs/claim"))).toBe(false);
  });
});

/** `GET /spinoffs` as the server answers it: filtered by the `status` query, which reconcile now asks twice (1596). */
const byStatus = (rows: Array<ReturnType<typeof row>>) => (_b: Record<string, unknown>, req: ApiRequest) => ({
  spinoffs: rows.filter((r) => req.url.includes(`status=${r.status}`)),
});

describe("reconcile and cleanup: this machine's git, the API's rows (360)", () => {
  test("reconcile lands a merged branch over the API, and reports a blocked one instead of landing it", async () => {
    const restoreSh = __setSh((cmd) => {
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "build-360\nmain\n" };
      if (cmd.includes("rev-list")) return { ok: true, err: "", out: "3\n" };
      return { ok: true, err: "", out: "abc123\n" };
    });
    try {
      const launched = row({ status: "launched", base_sha: "abc123", repo: "/tmp/omnislash-fake-repo" });
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": byStatus([launched]),
        "POST /spinoffs/land": { id: 7, landed: true, blocked: null },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "reconcile"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("marked landed: 360");
      const landBody = s.bodies[s.calls.findIndex((c) => c.url.endsWith("/spinoffs/land"))]!;
      expect(landBody.id).toBe(7);
      expect(landBody.tokens).toBeDefined();

      const blocked = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": byStatus([launched]),
        "POST /spinoffs/land": { id: 7, landed: false, blocked: { resource: "ticket:360", holder: "architect-omnislash" } },
      });
      const r2 = await runCli(freshDbPath(), ["spinoff", "reconcile"], api(blocked));
      expect(r2.code).toBe(0);
      expect(r2.out).toContain("not landed, ticket:360 held by architect-omnislash");
    } finally {
      restoreSh();
    }
  });

  test("reconcile lands a done ticket or an origin/main squash when local main has not moved (937)", async () => {
    const { repo, base } = gitWithOriginMain("fix(ob 932): resume the architect");
    const restoreSh = __setSh((cmd) => {
      // Local main has not moved: the branch is not merged here, and it has no unique commits.
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "main\n" };
      if (cmd.includes("rev-list")) return { ok: true, err: "", out: "0\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const done = row({ id: 15, ticket_ref: "915", status: "launched", branch: "915", repo, base_sha: base });
      const squash = row({ id: 32, ticket_ref: "932", status: "launched", branch: "932", repo, base_sha: base }); // base BEFORE the squash, so it is provably this row's land (1201)
      const open = row({ id: 18, ticket_ref: "918", status: "launched", branch: "918", repo, base_sha: base });
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": byStatus([done, squash, open]),
        "GET /items": { items: [{ id: "915", status: "done" }] },
        "POST /spinoffs/land": { id: 0, landed: true, blocked: null },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "reconcile"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("marked landed: 915, 932");
      expect(r.out).not.toContain("918");
      const landedIds = s.bodies.filter((b) => typeof b.id === "number" && s.calls[s.bodies.indexOf(b)]?.url.endsWith("/spinoffs/land")).map((b) => b.id);
      expect(landedIds).toEqual([15, 32]);
    } finally {
      restoreSh();
      rmSync(repo, { recursive: true, force: true });
    }
  }, spawnBudget(8));

  test("OB-2182: reconcile lands a handed-off row whose OB-N ticket is done, matched by the item's ref", async () => {
    const restoreSh = __setSh((cmd) => {
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "main\n" };
      if (cmd.includes("rev-list")) return { ok: true, err: "", out: "0\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      // Refs are what a row carries since 1949; the item's internal id (3824) is not the ref.
      const landed = row({ id: 2022, ticket_ref: "OB-2187", status: "ready-for-gate", branch: "ob-2187", repo: "/tmp/omnislash-fake-repo", base_sha: "abc" });
      const open = row({ id: 2023, ticket_ref: "OB-2188", status: "ready-for-gate", branch: "ob-2188", repo: "/tmp/omnislash-fake-repo", base_sha: "abc" });
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": byStatus([landed, open]),
        "GET /items": { items: [{ id: "3824", ref: "OB-2187", status: "done" }] }, // status=done only, as the server answers it
        "POST /spinoffs/land": { id: 0, landed: true, blocked: null },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "reconcile"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("marked landed: OB-2187");
      expect(r.out).not.toContain("OB-2188");
      const landedIds = s.bodies.filter((b, i) => s.calls[i]?.url.endsWith("/spinoffs/land")).map((b) => b.id);
      expect(landedIds).toEqual([2022]);
    } finally {
      restoreSh();
    }
  });

  test("OB-2182: list --json marks a building OB-N row landed when its ticket is done (by ref)", async () => {
    const s = stub({
      "GET /spinoffs": { spinoffs: [row({ id: 2022, ticket_ref: "OB-2187", status: "launched", branch: "ob-2187", repo: "/tmp/omnislash-fake-repo", base_sha: "abc" })] },
      "GET /spinoffs/config": configAnswer(),
      "GET /items": { items: [{ id: "3824", ref: "OB-2187", status: "done" }] },
    });
    const r = await runCli(freshDbPath(), ["spinoff", "list", "--json"], api(s));
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as Array<{ ticket_ref: string; landed: boolean }>)[0]?.landed).toBe(true);
  }, spawnBudget(8));

  test("OB-2182: a pre-1949 bare-number row still matches its done item by id, and a null ref adds nothing", async () => {
    const restoreSh = __setSh((cmd) => {
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "main\n" };
      if (cmd.includes("rev-list")) return { ok: true, err: "", out: "0\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const bare = row({ id: 915, ticket_ref: "915", status: "ready-for-gate", branch: "915", repo: "/tmp/omnislash-fake-repo", base_sha: "abc" });
      const other = row({ id: 916, ticket_ref: "916", status: "ready-for-gate", branch: "916", repo: "/tmp/omnislash-fake-repo", base_sha: "abc" });
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": byStatus([bare, other]),
        "GET /items": { items: [{ id: "915", ref: null, status: "done" }] },
        "POST /spinoffs/land": { id: 0, landed: true, blocked: null },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "reconcile"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("marked landed: 915");
      expect(r.out).not.toContain("916");
      const landedIds = s.bodies.filter((b, i) => s.calls[i]?.url.endsWith("/spinoffs/land")).map((b) => b.id);
      expect(landedIds).toEqual([915]);
    } finally {
      restoreSh();
    }
  });

  test("reconcile lands a handed-off row whose ticket is done, and leaves an open one alone (1596)", async () => {
    const restoreSh = __setSh((cmd) => {
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "main\n" };
      if (cmd.includes("rev-list")) return { ok: true, err: "", out: "0\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const landed = row({ id: 71, ticket_ref: "1591", status: "ready-for-gate", branch: "1591", repo: "/tmp/omnislash-fake-repo", base_sha: "abc" });
      const open = row({ id: 64, ticket_ref: "1417", status: "ready-for-gate", branch: "1417", repo: "/tmp/omnislash-fake-repo", base_sha: "abc" });
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": byStatus([landed, open]),
        "GET /items": { items: [{ id: "1591", status: "done" }] },
        "POST /spinoffs/land": { id: 0, landed: true, blocked: null },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "reconcile"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("marked landed: 1591");
      expect(r.out).not.toContain("1417");
      const landedIds = s.bodies.filter((b, i) => s.calls[i]?.url.endsWith("/spinoffs/land")).map((b) => b.id);
      expect(landedIds).toEqual([71]);
    } finally {
      restoreSh();
    }
  });

  test("reconcile mirrors the live t3 rows' run state over the API (1120)", async () => {
    const registered: Array<Record<string, unknown>> = [];
    const restoreSh = __setSh((cmd) => {
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "main\n" };
      if (cmd.includes("rev-list")) return { ok: true, err: "", out: "0\n" };
      return { ok: true, err: "", out: "" };
    });
    const restoreSeam = __setT3Seam({
      projects: async () => [],
      capabilities: async () => ({ runtimeMode: "full-access", providers: [] }),
      list: async () => ({ projectId: "p", threads: [], nextCursor: null }),
      read: async (threadId: string) => ({
        thread: {
          threadId,
          projectId: "p",
          title: "360",
          status: "running",
          worktreePath: "/repo.build-360",
          branch: "build-360",
          settled: false,
          archived: false,
          model: "m",
          providerInstanceId: "opencode",
          activeRunId: "run-1",
          latestRunId: "run-1",
          pendingRequestCount: 0,
        },
        recentRuns: [],
        items: [],
        nextPosition: 0,
        hasMore: false,
      }),
      launch: async () => {
        throw new Error("reconcile must not launch");
      },
      rename: async () => {},
      settle: async () => {},
      send: async () => {},
      wait: async () => ({ runId: null, status: "idle", timedOut: false }),
      // 1205: an empty architect queue, nothing held for a land to withdraw.
      queue: async () => ({ items: [], complete: true }),
      pin: async (id) => {
        throw new Error(`pin ${id}: only a group thread is pinned (OB-2251), never an architect (OB-2122)`);
      },
      unpin: async () => {},
      disableAutoSettle: async () => {},
      queueCancel: async () => {},
      interrupt: async () => {},
    });
    try {
      const live = row({ status: "launched", launcher: "t3", t3_thread_id: "mcp:t3-1", agent_id: "build-360" });
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": { spinoffs: [live] },
        "POST /agents": (body: Record<string, unknown>) => {
          registered.push(body);
          return { agent: null, found: true, ticket_lease: null, released: [] };
        },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "reconcile"], api(s));
      expect(r.code).toBe(0);
      // The mirror ran HERE (the threads are on this machine) and wrote the row over the API. 1189: T3's
      // word goes to `run`, and `status` is left alone — the two vocabularies have a field each.
      expect(r.out).toContain("T3 run running");
      // OB-1923: the write is `set-run`, which updates an existing row and never registers one.
      expect(registered[0]).toEqual({ action: "set-run", id: "build-360", run: "running" });
    } finally {
      restoreSeam();
      restoreSh();
    }
  });

  // OB-1923: the API path of the update-only mirror. Handed-off rows are read, merged ones are not, and an
  // agent the server no longer has is a named skip rather than a recreated row.
  test("reconcile mirrors a handed-off t3 row, never reads a merged one, and skips a deleted agent by name (OB-1923)", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const readThreads: string[] = [];
    const restoreSh = __setSh((cmd) => {
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "main\n" };
      if (cmd.includes("rev-list")) return { ok: true, err: "", out: "0\n" };
      return { ok: true, err: "", out: "" };
    });
    const restoreSeam = __setT3Seam({
      projects: async () => [],
      capabilities: async () => ({ runtimeMode: "full-access", providers: [] }),
      list: async () => ({ projectId: "p", threads: [], nextCursor: null }),
      read: async (threadId: string) => {
        readThreads.push(threadId);
        return {
          thread: {
            threadId,
            projectId: "p",
            title: threadId,
            status: "running",
            worktreePath: "/repo.x",
            branch: "x",
            settled: false,
            archived: false,
            model: "m",
            providerInstanceId: "opencode",
            activeRunId: "run-1",
            latestRunId: "run-1",
            pendingRequestCount: 0,
          },
          recentRuns: [],
          items: [],
          nextPosition: 0,
          hasMore: false,
        };
      },
      launch: async () => {
        throw new Error("reconcile must not launch");
      },
      rename: async () => {},
      settle: async () => {},
      send: async () => {},
      wait: async () => ({ runId: null, status: "idle", timedOut: false }),
      queue: async () => ({ items: [], complete: true }),
      pin: async (id) => {
        throw new Error(`pin ${id}: only a group thread is pinned (OB-2251), never an architect (OB-2122)`);
      },
      unpin: async () => {},
      disableAutoSettle: async () => {},
      queueCancel: async () => {},
      interrupt: async () => {},
    });
    try {
      const handedOff = row({ id: 1, ticket_ref: "1923", status: "ready-for-gate", launcher: "t3", t3_thread_id: "mcp:t3-h", agent_id: "b-h", branch: "b-h" });
      const gone = row({ id: 2, ticket_ref: "1924", status: "launched", launcher: "t3", t3_thread_id: "mcp:t3-g", agent_id: "b-g", branch: "b-g" });
      const merged = row({ id: 3, ticket_ref: "1925", status: "merged", launcher: "t3", t3_thread_id: "mcp:t3-m", agent_id: "b-m", branch: "b-m" });
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "GET /spinoffs": byStatus([handedOff, gone, merged]),
        "GET /items": { items: [] },
        "POST /agents": (body: Record<string, unknown>) => {
          posted.push(body);
          const found = body.id !== "b-g"; // the server has no row for b-g
          return { agent: null, found, ticket_lease: null, released: [] };
        },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "reconcile"], api(s));
      expect(r.code).toBe(0);
      expect(readThreads.sort()).toEqual(["mcp:t3-g", "mcp:t3-h"]); // merged is never read
      expect(posted.every((b) => b.action === "set-run")).toBe(true); // never a register
      expect(posted).toContainEqual({ action: "set-run", id: "b-h", run: "running" });
      expect(r.out).toContain("1923: T3 run running");
      expect(r.out).not.toContain("1924: T3 run");
      expect(r.err).toContain("1924: no agent row 'b-g': the mirror never creates one");
    } finally {
      restoreSeam();
      restoreSh();
    }
  });

  test("cleanup refuses a worktree whose t3 thread has a live run, over the API too (1120)", async () => {
    const restoreSh = __setSh((cmd) => {
      if (cmd[0] === "ps") return { ok: true, err: "", out: psTable() };
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return { ok: true, err: "", out: "worktree /repo\nbranch refs/heads/main\n\nworktree /repo.build-360\nbranch refs/heads/build-360\n\n" };
      }
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "build-360\nmain\n" };
      if (cmd.includes("for-each-ref")) return { ok: true, err: "", out: "main\nbuild-360\n" };
      return { ok: true, err: "", out: "" };
    });
    const restoreSeam = __setT3Seam({
      projects: async () => [],
      capabilities: async () => ({ runtimeMode: "full-access", providers: [] }),
      list: async () => ({ projectId: "p", threads: [], nextCursor: null }),
      read: async (threadId: string) => ({
        thread: {
          threadId,
          projectId: "p",
          title: "360",
          status: "running",
          worktreePath: "/repo.build-360",
          branch: "build-360",
          settled: false,
          archived: false,
          model: "m",
          providerInstanceId: "opencode",
          activeRunId: "run-1",
          latestRunId: "run-1",
          pendingRequestCount: 0,
        },
        recentRuns: [],
        items: [],
        nextPosition: 0,
        hasMore: false,
      }),
      launch: async () => {
        throw new Error("cleanup must not launch");
      },
      rename: async () => {},
      settle: async () => {},
      send: async () => {},
      wait: async () => ({ runId: null, status: "idle", timedOut: false }),
      // 1205: an empty architect queue, nothing held for a land to withdraw.
      queue: async () => ({ items: [], complete: true }),
      pin: async (id) => {
        throw new Error(`pin ${id}: only a group thread is pinned (OB-2251), never an architect (OB-2122)`);
      },
      unpin: async () => {},
      disableAutoSettle: async () => {},
      queueCancel: async () => {},
      interrupt: async () => {},
    });
    try {
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        // The lease question comes back clear; the T3 question is what must stop the removal.
        "POST /spinoffs/cleanup-guard": { hold: null, agent: false },
        // OB-2159: a landed row, since a live one is skipped by its own guard before T3 is asked.
        "GET /spinoffs": { spinoffs: [row({ status: "merged", launcher: "t3", t3_thread_id: "mcp:t3-1", worktree: "/repo.build-360" })] },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "cleanup", "--repo", "/repo", "--dry-run"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("SKIPPED");
      expect(r.out).toContain("live run");
    } finally {
      restoreSeam();
      restoreSh();
    }
  });

  test("cleanup asks the API which candidates a live session holds, and skips those", async () => {
    const restoreSh = __setSh((cmd) => {
      if (cmd[0] === "ps") return { ok: true, err: "", out: psTable() };
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return { ok: true, err: "", out: "worktree /repo\nbranch refs/heads/main\n\nworktree /repo.build-360\nbranch refs/heads/build-360\n\n" };
      }
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "build-360\nmain\n" };
      if (cmd.includes("for-each-ref")) return { ok: true, err: "", out: "main\nbuild-360\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const s = stub({
        "GET /spinoffs/config": configAnswer(),
        "POST /spinoffs/cleanup-guard": { hold: { resource: "worktree:/repo.build-360", holder: "architect-omnislash" }, agent: false },
      });
      const r = await runCli(freshDbPath(), ["spinoff", "cleanup", "--repo", "/repo", "--dry-run"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("SKIPPED");
      expect(r.out).toContain("leased");
      expect(r.out).toContain("architect-omnislash");
      // The guard was ASKED, rather than assumed by a client re-deriving lease semantics.
      expect(s.calls.some((c) => c.url.endsWith("/spinoffs/cleanup-guard"))).toBe(true);
    } finally {
      restoreSh();
    }
  });
});

// --- the server half, over a real Postgres store -------------------------------------------------------

const PG_TOKEN = "a-test-bearer-token-that-is-long-enough";

async function withApi(fn: (ctx: { store: Store; call: (path: string, opts?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any }> }) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const handler = createObApi({
    store: async () => store,
    token: () => ({ token: PG_TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const call = async (path: string, opts: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${PG_TOKEN}` };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await handler(
      new Request(`http://api-host.local${OB_API_PREFIX}${path}`, {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
  };
  try {
    await fn({ store, call });
  } finally {
    await store.close();
    await lease.release();
  }
}

describe("the served queue, against a real store (360)", () => {
  test(
    "an enqueued row reads back, and the SECOND claim of it gets nothing: 308's exclusion is intact",
    async () => {
      await withApi(async ({ store, call }) => {
        const created = await call("/spinoffs", {
          body: { no_check: "a test fixture", ticket_ref: "360", repo: "omnislash", branch: "build-360", mode: "agent", brief: "do it" },
        });
        expect(created.status).toBe(201);
        expect(created.body.deduped).toBe(false);
        const id = created.body.row.id as number;
        // The repo is stored VERBATIM: the client resolved the slug, and re-resolving it here would look
        // for the owner's checkouts on a host that has none of them (217).
        expect(created.body.row.repo).toBe("omnislash");

        const listed = await call("/spinoffs?status=pending");
        expect(listed.status).toBe(200);
        expect(listed.body.spinoffs.map((r: { id: number }) => r.id)).toEqual([id]);

        const plan = await call("/spinoffs/launchable", { body: { caller: "test-caller" } });
        expect(plan.status).toBe(200);
        expect(typeof plan.body.active).toBe("number"); // not a string: Postgres count() is text
        expect(plan.body.rows.map((r: { row: { id: number } }) => r.row.id)).toEqual([id]);
        expect(plan.body.rows[0].hold).toBeNull();

        const first = await call("/spinoffs/claim", { body: { id } });
        expect(first.status).toBe(200);
        expect(first.body.claimed.id).toBe(id);
        expect(first.body.error).toBeNull();

        // THE POINT. The claim is one conditional UPDATE against `status='pending'`, so the row is no
        // longer pending and a second drain asking for it gets NOTHING rather than a second tab.
        const second = await call("/spinoffs/claim", { body: { id } });
        expect(second.status).toBe(200);
        expect(second.body.claimed).toBeNull();

        const stamped = await call("/spinoffs/stamp", {
          body: { id, outcome: "launched", worktree: "/tmp/wt", base_sha: "abc123", launcher: "headless" },
        });
        expect(stamped.status).toBe(200);
        const rows = await listSpinoffs(store, "launched");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.worktree).toBe("/tmp/wt");
        expect(rows[0]!.agent_id).toBe("build-360");

        // A re-dispatch of the BUILDING ticket reuses its live row: deduped, the same id, nothing inserted,
        // so no second builder is put on the same worktree.
        const again = await call("/spinoffs", {
          body: { no_check: "a test fixture", ticket_ref: "360", repo: "omnislash", branch: "build-360", mode: "agent", brief: "do it again" },
        });
        expect(again.status).toBe(201); // the route always answers 201; `deduped` says nothing was inserted
        expect(again.body.deduped).toBe(true);
        expect(again.body.row.id).toBe(id);
        expect(again.body.row.status).toBe("launched");
        expect(await listSpinoffs(store)).toHaveLength(1);

        const landed = await call("/spinoffs/land", {
          body: { id, tokens: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 3 } },
        });
        expect(landed.status).toBe(200);
        expect(landed.body.landed).toBe(true);
        const merged = await listSpinoffs(store, "merged");
        expect(merged).toHaveLength(1);
        expect(merged[0]!.total_tokens).toBe(3);
      });
    },
    BUDGET,
  );

  test(
    "the config endpoint answers with VALUES, and a bad status filter is refused by name",
    async () => {
      await withApi(async ({ call }) => {
        const cfg = await call("/spinoffs/config");
        expect(cfg.status).toBe(200);
        expect(typeof cfg.body.config.engine).toBe("string");
        expect(typeof cfg.body.config.repo_checkouts).toBe("object");

        const bad = await call("/spinoffs?status=nonsense");
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe("invalid_request");

        const readyFilter = await call("/spinoffs?status=ready-for-gate");
        expect(readyFilter.status).toBe(200);

        // An id is validated as a positive INTEGER, never coerced from a string.
        const coerced = await call("/spinoffs/claim", { body: { id: "1" } });
        expect(coerced.status).toBe(400);
      });
    },
    BUDGET,
  );

  // 1163: the ref a client dispatches with is not always the item's id (a hand-charted ticket is
  // dispatched by its wayfinder number). The identity is resolved on the HOST — that is where the items
  // live — recorded on the row, and listed back, because the client's settle-on-close and the read surface
  // all join through it.
  test(
    "POST /spinoffs records the ob item the ref serves, and it reads back (1163)",
    async () => {
      await withApi(async ({ store, call }) => {
        const ts = "2026-10-17T20:00:00.000Z";
        await store.txn("seed the mirror", async (s) => {
          await s.q.insert(s.t.item).values({
            id: "1134",
            type: "task",
            title: "T3 integration P1",
            body: "wayfinder/tickets/1124-t3-read-surface.md — the read half",
            status: "open",
            created_at: ts,
            updated_at: ts,
          });
        });
        // dispatched by its WAYFINDER number: the row's ref and its item differ.
        const created = await call("/spinoffs", {
          body: { no_check: "a test fixture", ticket_ref: "1124", repo: "omnislash", branch: "1124", mode: "interactive", brief: "build it" },
        });
        expect(created.status).toBe(201);
        expect(created.body.row.item_id).toBe("1134");

        const listed = await call("/spinoffs?status=pending");
        expect(listed.body.spinoffs[0].item_id).toBe("1134");
        expect(listed.body.spinoffs[0].ticket_ref).toBe("1124");
      });
    },
    BUDGET,
  );

  test(
    "POST /spinoffs/serving answers the rows that SERVE an item, the ref's ticket path beating the bare id (1226)",
    async () => {
      await withApi(async ({ store, call }) => {
        const ts = "2026-10-18T00:00:00.000Z";
        await store.txn("seed the two colliding mirrors", async (s) => {
          await s.q.insert(s.t.item).values({
            id: "1133",
            type: "task",
            title: "S2 · the strip",
            body: "wayfinder/tickets/1121-strip-ob.md — the S2 half",
            status: "open",
            created_at: ts,
            updated_at: ts,
          });
          await s.q.insert(s.t.item).values({
            id: "1135",
            type: "task",
            title: "The readying note",
            body: "wayfinder/tickets/1133-readying-note.md — readiness is announced",
            status: "open",
            created_at: ts,
            updated_at: ts,
          });
        });
        // dispatched under the READYING ticket's wayfinder number, which IS the strip mirror's item id
        const created = await call("/spinoffs", {
          body: { no_check: "a test fixture", ticket_ref: "1133", repo: "omnislash", branch: "1133", mode: "interactive", brief: "build it" },
        });
        expect(created.status).toBe(201);
        expect(created.body.row.item_id).toBe("1135");
        const id = created.body.row.id as number;
        // …and the row 595 shape: queued before 0032 recorded an identity at all, so this read is the only
        // thing that can join it. The question is asked HERE because a client holds T3 and no store.
        await store.q.update(store.t.spinoff).set({ item_id: null }).where(eq(store.t.spinoff.id, id));

        const forStrip = await call("/spinoffs/serving", { body: { item_id: "1133" } });
        expect(forStrip.status).toBe(200);
        expect(forStrip.body.spinoffs).toEqual([]);

        const forReadying = await call("/spinoffs/serving", { body: { item_id: "1135" } });
        expect(forReadying.status).toBe(200);
        expect(forReadying.body.spinoffs.map((r: { id: number }) => r.id)).toEqual([id]);

        // An id no item holds is refused by name: an empty list would read exactly like a ticket whose rows
        // have all been retired.
        const missing = await call("/spinoffs/serving", { body: { item_id: "9999" } });
        expect(missing.status).toBe(404);
        expect(missing.body.error.message).toContain("no item '9999'");
      });
    },
    BUDGET,
  );

  test(
    "POST /spinoffs/serving NAMES a candidate row it could not resolve, rather than dropping it (1226)",
    async () => {
      await withApi(async ({ store, call }) => {
        const ts = "2026-10-18T00:00:00.000Z";
        await store.txn("seed a ref two mirrors claim", async (s) => {
          await s.q.insert(s.t.item).values({ id: "6", type: "task", title: "The stamp route", body: null, status: "open", created_at: ts, updated_at: ts });
          for (const id of ["7", "8"]) {
            await s.q.insert(s.t.item).values({ id, type: "task", title: `mirror ${id}`, body: "wayfinder/tickets/6-two-ways.md — both claim it", status: "open", created_at: ts, updated_at: ts });
          }
        });
        const created = await call("/spinoffs", {
          body: { no_check: "a test fixture", ticket_ref: "6", repo: "omnislash", branch: "6", mode: "interactive", brief: "x" },
        });
        const id = created.body.row.id as number;
        // the row 595 shape again: an identity recorded by an older rule is not what this read trusts
        await store.q.update(store.t.spinoff).set({ item_id: null }).where(eq(store.t.spinoff.id, id));

        const answer = await call("/spinoffs/serving", { body: { item_id: "6" } });
        expect(answer.status).toBe(200);
        // Nothing serves item 6 — and the close's reader is told WHICH row it could not settle, because an
        // empty list on its own reads exactly like "this ticket never dispatched anything".
        expect(answer.body.spinoffs).toEqual([]);
        expect(answer.body.unresolved).toEqual([{ id, ticket_ref: "6" }]);
      });
    },
    BUDGET,
  );

  test(
    "POST /spinoffs/ready stamps launched → ready-for-gate and does not land the row",
    async () => {
      await withApi(async ({ store, call }) => {
        const created = await call("/spinoffs", {
          body: { no_check: "a test fixture", ticket_ref: "391", repo: "omnislash", branch: "391", mode: "interactive", brief: "done" },
        });
        const id = created.body.row.id as number;
        await call("/spinoffs/claim", { body: { id } });
        await call("/spinoffs/stamp", { body: { id, outcome: "launched", worktree: "/tmp/wt-391" } });

        const ready = await call("/spinoffs/ready", { body: { id } });
        expect(ready.status).toBe(200);
        expect(ready.body.already).toBe(false);
        expect(ready.body.row.status).toBe("ready-for-gate");
        expect((await listSpinoffs(store, "ready-for-gate")).map((r) => r.id)).toEqual([id]);
        expect((await listSpinoffs(store, "merged"))).toEqual([]);

        const again = await call("/spinoffs/ready", { body: { ticket_ref: "391" } });
        expect(again.status).toBe(200);
        expect(again.body.already).toBe(true);
      });
    },
    BUDGET,
  );

  test(
    "POST /spinoffs/note-error records a failed note on the row and a sent one clears it (OB-2172)",
    async () => {
      await withApi(async ({ store, call }) => {
        const created = await call("/spinoffs", {
          body: { no_check: "a test fixture", ticket_ref: "2172", repo: "omnislash", branch: "ob-2172", mode: "interactive", brief: "note" },
        });
        const id = created.body.row.id as number;
        const noteError = async () => (await listSpinoffs(store)).find((r) => r.id === id)?.note_error ?? null;

        const failed = await call("/spinoffs/note-error", { body: { id, outcome: "failed", reason: "T3 refused it" } });
        expect(failed.status).toBe(200);
        expect(failed.body.recorded).toBe(true);
        expect(await noteError()).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z T3 refused it$/);

        expect((await call("/spinoffs/note-error", { body: { id, outcome: "sent" } })).status).toBe(200);
        expect(await noteError()).toBeNull();

        expect((await call("/spinoffs/note-error", { body: { id, outcome: "bogus" } })).status).toBe(400);
        expect((await call("/spinoffs/note-error", { body: { id: 999999, outcome: "sent" } })).status).toBe(404);
      });
    },
    BUDGET,
  );

  // 1142: the T3 ids are facts about the CLIENT's machine, so this ROUTE is the only way they reach the
  // row. It rebuilds the request field by field, and it silently dropped both -- the handler copies
  // whatever it is handed, so a handler-level test passed while every real (API) launch stamped nulls and
  // settle-on-close, adoption and the cleanup guard all read those columns. Hence: through the route, and
  // read back through the listing the adopters actually use.
  test(
    "POST /spinoffs/stamp persists the T3 thread and run ids, and they read back (1142)",
    async () => {
      await withApi(async ({ store, call }) => {
        const created = await call("/spinoffs", {
          body: { no_check: "a test fixture", ticket_ref: "1142", repo: "omnislash", branch: "build-1142", mode: "agent", brief: "stamp it" },
        });
        const id = created.body.row.id as number;
        // OB-1920: a launch stamp needs a claimed row, as the drain makes before it stamps.
        expect((await call("/spinoffs/claim", { body: { id } })).status).toBe(200);

        const stamped = await call("/spinoffs/stamp", {
          body: {
            id,
            outcome: "launched",
            worktree: "/tmp/wt-1142",
            launcher: "t3",
            t3_thread_id: "mcp:t3-1142",
            t3_run_id: "run-1142",
          },
        });
        expect(stamped.status).toBe(200);

        const rows = await listSpinoffs(store, "launched");
        expect(rows[0]!.t3_thread_id).toBe("mcp:t3-1142");
        expect(rows[0]!.t3_run_id).toBe("run-1142");

        // The read surface is the other half of the wire: adoption (dispatch.ts) and the live-run refusal
        // in `spinoff cleanup` look rows up through the API, so a column persisted but not listed would
        // still leave all three guards blind.
        const listed = await call("/spinoffs?status=launched");
        expect(listed.body.spinoffs[0].t3_thread_id).toBe("mcp:t3-1142");
        expect(listed.body.spinoffs[0].t3_run_id).toBe("run-1142");
      });
    },
    BUDGET,
  );
});

describe("ob spinoff ready over the API client (391)", () => {
  test("lists, then POSTs /spinoffs/ready with the resolved id, and does not land", async () => {
    // A REAL directory since 1188: `spinoff ready` (here over the API) refuses a row whose worktree is gone,
    // which is the guard that stops a woken builder announcing landed work.
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-391-api-"));
    // omnislash: the State line in git is the verdict there (OB-1992), which is what this stub's git answers.
    const launched = row({ status: "launched", ticket_ref: "391", branch: "391", worktree: wt, launcher: "t3", repo: "/tmp/fake/omnislash" });
    const s = stub({
      "GET /spinoffs": { spinoffs: [launched] },
      "POST /spinoffs/ready": {
        row: { ...launched, status: "ready-for-gate" },
        already: false,
        leasesReleased: false,
        // 1133: the host reads the builder's readying note BEFORE the stamp overwrites it and sends it back.
        builder_note: "nx typecheck clean; skeptical-review: 3 cut, 0 open",
      },
      // 1133, OB-2255: the readying note resolves the ticket's project, its team and the team's thread over the
      // API. The project is in no team here, so the note is the NAMED SKIP, which is the point: a notifier
      // never fails the stamp.
      "GET /items/391": { item: { id: "391", project: "omnislash", tags: [] } },
      "GET /projects": { projects: [{ ...OMNISLASH_PROJECT, team_name: null }] },
      "GET /agents": { agents: [] },
    });
    const restore = __setSh((cmd) =>
      cmd[0] === "gh" ? { ok: true, err: "", out: "[]" } : cmd.includes("--porcelain") ? { ok: true, err: "", out: "" } : { ok: true, err: "", out: "State: ready — gated\n" },
    );
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "ready", "391"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("391 handed off");
      expect(r.out).toContain("omnislash is in no team: ob t3 team join <team> omnislash, or ob t3 architect in its checkout");
      expect(s.calls.some((c) => c.url.endsWith("/spinoffs/ready"))).toBe(true);
      expect(s.calls.some((c) => c.url.endsWith("/spinoffs/land"))).toBe(false);
      const body = s.bodies[s.calls.findIndex((c) => c.url.endsWith("/spinoffs/ready"))]!;
      expect(body.id).toBe(7);
    } finally {
      restore();
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("--no-note stamps over the wire and never consults the architect at all (1205)", async () => {
    // The architect's OWN stamp (`ob-land` runs it on the human's behalf): the note would go to the thread
    // the caller IS, queued and delivered when that same turn ends — after the land it announces. This
    // pins the strongest form of "no note": the announce machinery is never even reached, so nothing
    // resolves the architect's grouping, reads its registry row, or opens a T3 seam.
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-1205-api-"));
    const launched = row({ status: "launched", ticket_ref: "1205", branch: "1205", worktree: wt, launcher: "t3", repo: "/tmp/fake/omnislash" });
    const s = stub({
      "GET /spinoffs": { spinoffs: [launched] },
      "POST /spinoffs/ready": {
        row: { ...launched, status: "ready-for-gate" },
        already: false,
        leasesReleased: true,
        builder_note: "nx typecheck clean; skeptical-review: 0 cut, 0 open",
      },
      // Deliberately NO `GET /config` and NO `GET /agents`: with the flag the stamp must not read them. A
      // stray request would 404 and warn, which `r.err` below would catch.
      "GET /spinoffs/config": configAnswer(),
    });
    const restore = __setSh((cmd) =>
      cmd[0] === "gh" ? { ok: true, err: "", out: "[]" } : cmd.includes("--porcelain") ? { ok: true, err: "", out: "" } : { ok: true, err: "", out: "State: ready — gated\n" },
    );
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "ready", "1205", "--no-note"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("1205 handed off");
      expect(r.out).toContain("--no-note: stamped only, nothing announced");
      expect(s.calls.some((c) => c.url.endsWith("/spinoffs/ready"))).toBe(true);
      expect(s.calls.some((c) => c.url.endsWith("/config"))).toBe(false);
      expect(s.calls.some((c) => c.url.endsWith("/agents"))).toBe(false);
      expect(r.err).toBe("");
    } finally {
      restore();
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("ob spinoff handoff reads the PR's CI over the API client (OB-2044)", () => {
  const HEAD = "a".repeat(40);
  const prList = (checks: unknown[], headRefOid = HEAD) => JSON.stringify([{ number: 431, url: "https://github.com/o/r/pull/431", headRefOid, statusCheckRollup: checks }]);
  const check = (name: string, status: string, conclusion: string) => ({ __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://github.com/o/r/actions/runs/${name}` });

  /** A launched omnislash row in a real worktree, the stubbed transport, and a git/gh seam answering the given `gh pr list`. */
  function setup(ghOut: string | { err: string }) {
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-2044-api-"));
    const launched = row({ status: "launched", ticket_ref: "2044", branch: "2044", worktree: wt, launcher: "t3", repo: "/tmp/fake/omnislash" });
    const s = stub({
      "GET /spinoffs": { spinoffs: [launched] },
      "POST /spinoffs/ready": { row: { ...launched, status: "ready-for-gate" }, already: false, leasesReleased: true, builder_note: "moon clean; skeptical-review: 0 cut, 0 open" },
      "GET /agents": { agents: [] },
      "GET /items/2044": { item: { id: "2044", tags: [] } },
    });
    const restore = __setSh((cmd) => {
      if (cmd[0] === "gh") return typeof ghOut === "string" ? { ok: true, err: "", out: ghOut } : { ok: false, err: ghOut.err, out: "" };
      if (cmd.includes("--porcelain")) return { ok: true, err: "", out: "" };
      if (cmd.join(" ").includes("rev-parse --verify")) return { ok: true, err: "", out: `${HEAD}\n` };
      return { ok: true, err: "", out: "State: landable\n" };
    });
    return { s, wt, restore };
  }
  const posted = (s: Stub) => s.calls.some((c) => c.url.endsWith("/spinoffs/ready"));

  test("a pending check is refused before the stamp: nothing is POSTed to /spinoffs/ready", async () => {
    const { s, wt, restore } = setup(prList([check("gate", "IN_PROGRESS", "")]));
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "handoff", "2044"], api(s));
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("CI still running on aaaaaaa: gate");
      expect(posted(s)).toBe(false);
    } finally {
      restore();
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("a failing check and a stale PR head are refused over the API client, with nothing POSTed", async () => {
    for (const [out, text] of [
      [prList([check("gate", "COMPLETED", "FAILURE")]), "gate: failure https://github.com/o/r/actions/runs/gate"],
      [prList([check("gate", "COMPLETED", "SUCCESS")], "b".repeat(40)), "PR #431 head is bbbbbbb, your HEAD is aaaaaaa: the two differ: push (or pull, if the PR is ahead)"],
    ] as const) {
      const { s, wt, restore } = setup(out);
      try {
        const r = await runCli(freshDbPath(), ["spinoff", "handoff", "2044"], api(s));
        expect(r.code).not.toBe(0);
        expect(r.err).toContain(text);
        expect(posted(s)).toBe(false);
      } finally {
        restore();
        rmSync(wt, { recursive: true, force: true });
      }
    }
  });

  test("a bad --tier-fit is a usage error before the CI read over the API client too", async () => {
    const { s, wt, restore } = setup(prList([check("gate", "COMPLETED", "FAILURE")]));
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "handoff", "2044", "--tier-fit", "sideways"], api(s));
      expect(r.code).not.toBe(0);
      expect(r.err).not.toContain("CI is failing");
      expect(r.err).toContain("tier-fit");
      expect(posted(s)).toBe(false);
    } finally {
      restore();
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("gh failing is COULD NOT READ CI over the API client too, and --ci-unchecked sends the reason with the stamp", async () => {
    const a = setup({ err: "gh: command not found" });
    try {
      const refused = await runCli(freshDbPath(), ["spinoff", "handoff", "2044"], api(a.s));
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("COULD NOT READ CI");
      expect(posted(a.s)).toBe(false);
      const through = await runCli(freshDbPath(), ["spinoff", "handoff", "2044", "--ci-unchecked", "gh is not installed here"], api(a.s));
      expect(through.code).toBe(0);
      const body = a.s.bodies[a.s.calls.findIndex((c) => c.url.endsWith("/spinoffs/ready"))]!;
      expect(String(body.note)).toContain("ci: UNCHECKED (--ci-unchecked: gh is not installed here)");
    } finally {
      a.restore();
      rmSync(a.wt, { recursive: true, force: true });
    }
  });

  test("a green PR POSTs the stamp with the ci line as the trail note", async () => {
    const { s, wt, restore } = setup(prList([check("gate", "COMPLETED", "SUCCESS"), check("ui-review", "COMPLETED", "SUCCESS")]));
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "handoff", "2044", "--note", "guard landed"], api(s));
      expect(r.code).toBe(0);
      const body = s.bodies[s.calls.findIndex((c) => c.url.endsWith("/spinoffs/ready"))]!;
      expect(String(body.note)).toContain("guard landed");
      expect(String(body.note)).toContain("ci: gate pass, ui-review pass on aaaaaaa");
    } finally {
      restore();
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("the API readying note carries the ci line (OB-2044)", () => {
  test("the note sent to the sentinel thread has the ci line on its gate line", async () => {
    const HEAD = "a".repeat(40);
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-2044-api-note-"));
    const launched = row({ status: "launched", ticket_ref: "2044", branch: "2044", worktree: wt, launcher: "t3", repo: "/tmp/fake/omnislash" });
    const s = stub({
      "GET /spinoffs": { spinoffs: [launched] },
      "POST /spinoffs/ready": { row: { ...launched, status: "ready-for-gate" }, already: false, leasesReleased: true, builder_note: "moon clean; skeptical-review: 0 cut, 0 open" },
      "GET /projects": { projects: [OMNISLASH_PROJECT] },
      "GET /agents": { agents: [{ id: "sentinel-omnislash", session_id: "sentinel-thread-1", launcher: "t3", status: "planning", run: null }] },
      "GET /items/2044": { item: { id: "2044", project: "omnislash", tags: [] } },
      "POST /spinoffs/note-error": { recorded: true },
    });
    const gh = JSON.stringify([
      { number: 431, url: "https://github.com/o/r/pull/431", headRefOid: HEAD, statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "u" }] },
    ]);
    const restoreSh = __setSh((cmd) => {
      if (cmd[0] === "gh") return { ok: true, err: "", out: gh };
      if (cmd.includes("--porcelain")) return { ok: true, err: "", out: "" };
      if (cmd.join(" ").includes("rev-parse --verify")) return { ok: true, err: "", out: `${HEAD}\n` };
      return { ok: true, err: "", out: "State: landable\n" };
    });
    const sends: Array<{ threadId: string; message: string }> = [];
    const restoreSeam = __setT3Seam({
      projects: async () => [],
      capabilities: async () => ({ runtimeMode: "full-access", providers: [] }),
      list: async () => ({ projectId: "p", threads: [], nextCursor: null }),
      read: async () => {
        throw new Error("unused");
      },
      launch: async () => {
        throw new Error("unused");
      },
      rename: async () => {},
      settle: async () => {},
      send: async (input) => {
        sends.push({ threadId: input.threadId, message: input.message });
      },
      wait: async () => ({ runId: null, status: "idle", timedOut: false }),
      queue: async () => ({ items: [], complete: true }),
      pin: async (id) => {
        throw new Error(`pin ${id}: only a group thread is pinned (OB-2251), never an architect (OB-2122)`);
      },
      unpin: async () => {},
      disableAutoSettle: async () => {},
      queueCancel: async () => {},
      interrupt: async () => {},
    });
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "handoff", "2044"], api(s));
      expect(r.code).toBe(0);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.message).toContain("ci: gate pass on aaaaaaa");
      expect(sends[0]!.message).toContain("review:    skeptical-review: 0 cut, 0 open");
      // OB-2172: a sent note clears the host row's note_error.
      const at = s.calls.findIndex((c) => c.url.endsWith("/spinoffs/note-error"));
      expect(at).toBeGreaterThanOrEqual(0);
      expect(s.bodies[at]).toMatchObject({ outcome: "sent" });
    } finally {
      restoreSeam();
      restoreSh();
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("`ob spinoff abandon` over the API (1697)", () => {
  test("retires the row and finishes the agent through the API, never as landed", async () => {
    const s = stub({
      "GET /spinoffs": { spinoffs: [row({ id: 783, ticket_ref: "abandon", branch: "abandon", status: "pending", agent_id: "abandon" })] },
      "POST /spinoffs/stamp": (body: Record<string, unknown>) => ({ id: body.id, outcome: body.outcome }),
      "POST /agents": (body: Record<string, unknown>) => ({ agent: body.id, found: true, released: ["ticket:abandon"] }),
    });
    const r = await runCli(freshDbPath(), ["spinoff", "abandon", "783", "--note", "mistaken launch"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("abandoned #783");
    expect(r.out).toContain("ticket:abandon");
    const stamp = s.calls.findIndex((c) => c.url.endsWith("/spinoffs/stamp"));
    expect(s.bodies[stamp]).toMatchObject({ id: 783, outcome: "failed", error: "abandoned: mistaken launch" });
    const done = s.calls.findIndex((c) => c.url.endsWith("/agents") && c.method === "POST");
    expect(s.bodies[done]).toMatchObject({ action: "done", id: "abandon" });
    expect(stamp).toBeLessThan(done);
    expect(s.calls.some((c) => c.url.endsWith("/spinoffs/land"))).toBe(false);
  });

  test("a subcommand word is refused before anything is queued or launched", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["spinoff", "queue", "abandon"], api(s));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("is a spinoff subcommand");
    expect(s.calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});

describe("OS-177: the served queue carries the complexity score", () => {
  test(
    "a client sending complexity stores it; a tier-only client is accepted and routes by its alias; a bad score is refused",
    async () => {
      await withApi(async ({ call }) => {
        const base = { no_check: "a test fixture", repo: "omnislash", mode: "agent", brief: "do it" };
        const scored = await call("/spinoffs", { body: { ...base, ticket_ref: "1771", branch: "build-1771", complexity: 3 } });
        expect(scored.status).toBe(201);
        expect([scored.body.row.complexity, scored.body.row.tier]).toEqual([3, "simple"]);

        const tierOnly = await call("/spinoffs", { body: { ...base, ticket_ref: "1772", branch: "build-1772", tier: "complex" } });
        expect(tierOnly.status).toBe(201);
        expect(tierOnly.body.row.tier).toBe("complex");
        expect(tierOnly.body.row.complexity).toBe(8); // the tier's alias value, stored

        const listed = await call("/spinoffs?status=pending");
        const byRef = Object.fromEntries(listed.body.spinoffs.map((r: { ticket_ref: string; complexity: number | null }) => [r.ticket_ref, r.complexity]));
        expect(byRef["1771"]).toBe(3);

        for (const bad of [0, 11, 3.5, "high"]) {
          const refused = await call("/spinoffs", { body: { ...base, ticket_ref: "1773", branch: "build-1773", complexity: bad } });
          expect(refused.status).toBe(400);
        }
      });
    },
    60_000,
  );
});

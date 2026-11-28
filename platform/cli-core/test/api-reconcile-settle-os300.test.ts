// OS-300: the apiReconcile settle path. A stuck `launching` row is settled only when GET /leases shows no live
// claim; a failed lease read settles none. A stuck row settled from a committed verdict records its T3 thread
// (a live one first, else a settled one), or ends failed when T3 holds none, so no "building" row has no thread.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { __setSh } from "../../cli-coord/src/commands/spinoff.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";

const BASE = "https://ob.example.test";
const REPO = "/tmp/omnislash-fake-repo";
const OLD = "2026-08-19T00:00:00.000Z"; // far past the claim TTL

type Row = Record<string, unknown> & { id: number; status: string };

function row(over: Partial<Row> = {}): Row {
  return {
    id: 7, ticket_ref: "OS-1", repo: REPO, branch: "os-1", worktree: "/tmp/omnislash-fake-worktree", mode: "interactive",
    brief: "a fix", status: "launching", error: null, agent_id: null, request_at: OLD, launched_at: OLD,
    input_tokens: null, output_tokens: null, cache_creation_tokens: null, cache_read_tokens: null, total_tokens: null,
    base_sha: null, reported_at: null, launcher: "t3", launch_attempts: 1, session_id: null, t3_thread_id: null, t3_run_id: null,
    item_id: null,
    ...over,
  };
}

interface Api {
  transport: ApiTransport;
  stamps: Array<Record<string, unknown>>;
  lands: Array<Record<string, unknown>>;
}

/** A server over `rows`: GET /spinoffs by status, a stamp that moves the row, a land that lands it. */
function server(rows: Row[], leases: unknown, done: string[] = []): Api {
  const stamps: Array<Record<string, unknown>> = [];
  const lands: Array<Record<string, unknown>> = [];
  const transport: ApiTransport = async (req: ApiRequest) => {
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    const path = req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!;
    const ok = (v: unknown) => ({ status: 200, body: JSON.stringify(v) });
    switch (`${req.method} ${path}`) {
      case "GET /spinoffs/config":
        return ok({ config: { repo_checkouts: {}, launcher: "t3", launcher_by_repo: {}, engine: "claude" } });
      case "GET /spinoffs":
        return ok({ spinoffs: rows.filter((r) => req.url.includes(`status=${r.status}`)) });
      case "GET /items":
        return ok({ items: done.map((ref) => ({ id: ref, ref, status: "done" })) });
      case "GET /leases":
        return leases === "fail" ? { status: 500, body: JSON.stringify({ error: { code: "boom", message: "lease table unreadable" } }) } : ok(leases);
      case "POST /spinoffs/stamp": {
        stamps.push(body);
        const r = rows.find((x) => x.id === body.id)!;
        r.status = body.outcome === "failed" ? "failed" : "launched";
        r.t3_thread_id = (body.t3_thread_id as string | null | undefined) ?? null;
        r.base_sha = (body.base_sha as string | null | undefined) ?? r.base_sha;
        r.error = (body.error as string | null | undefined) ?? null;
        return ok({ row: r });
      }
      case "POST /spinoffs/land":
        lands.push(body);
        return ok({ id: body.id, landed: true, blocked: null });
      default:
        return { status: 404, body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${req.method} ${path}` } }) };
    }
  };
  return { transport, stamps, lands };
}

const api = (s: Api) => ({ api: { base: BASE, token: "t", transport: s.transport } });
const reconcile = (s: Api) => runCli(freshDbPath(), ["spinoff", "reconcile"], api(s));

/** git as a stuck row sees it: nothing merged locally; `log` carries a verdict only when `verdict` is set. */
function git(verdict: boolean) {
  return __setSh((argv) => {
    if (argv.includes("--merged")) return { ok: true, err: "", out: "main\n" };
    if (argv.includes("rev-list")) return { ok: true, err: "", out: "0\n" };
    if (argv.includes("log")) return { ok: true, err: "", out: verdict ? "fix(OS-1): the build\n\nState: landable\n" : "" };
    if (argv.includes("merge-base")) return { ok: true, err: "", out: "fork1\n" };
    return { ok: true, err: "", out: "" };
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("apiReconcile settles stuck launching rows only on a complete lease read (OS-300)", () => {
  test("a complete read with no claim lease settles a stuck row on a done ticket, and it lands", async () => {
    cleanups.push(git(false));
    const s = server([row()], { leases: [] }, ["OS-1"]);
    const r = await reconcile(s);
    expect(r.code).toBe(0);
    expect(s.stamps.map((b) => [b.id, b.outcome])).toEqual([[7, "launched"]]);
    expect(s.lands.map((b) => b.id)).toEqual([7]);
    expect(r.out).toContain("marked landed: OS-1");
  }, spawnBudget(4));

  test("a live claim lease keeps the row with its launcher", async () => {
    cleanups.push(git(false));
    const live = { resource: "spinoff:7", holder: "os-1", since: OLD, ttl_s: 900, heartbeat_at: OLD, expired: false };
    const s = server([row()], { leases: [live] }, ["OS-1"]);
    await reconcile(s);
    expect(s.stamps).toEqual([]);
    expect(s.lands).toEqual([]);
  }, spawnBudget(4));

  test("a lease read that fails settles no launching row, and still retires a pending row on a done ticket", async () => {
    cleanups.push(git(false));
    const pending = row({ id: 8, ticket_ref: "OS-2", branch: "os-2", status: "pending", launched_at: null });
    const s = server([row(), pending], "fail", ["OS-1", "OS-2"]);
    const r = await reconcile(s);
    expect(s.stamps.map((b) => [b.id, b.outcome])).toEqual([[8, "failed"]]);
    expect(s.lands).toEqual([]);
    expect(r.err).toContain("stuck-row check skipped");
  }, spawnBudget(4));
});

describe("a stuck row settled from a committed verdict never reads building without a thread (OS-300)", () => {
  /** A worktree dir, git with a committed verdict, and a fake T3 holding `threads`. */
  function verdictRow(...threads: Array<(wt: string) => Record<string, unknown>>) {
    const worktree = mkdtempSync(join(tmpdir(), "ob-os300-"));
    cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
    cleanups.push(git(true));
    const t3 = installFakeT3([REPO]);
    cleanups.push(t3.restore);
    for (const t of threads) t3.threads.push(t(worktree) as never);
    return worktree;
  }

  test("its live T3 thread is recorded on the stamp", async () => {
    const worktree = verdictRow((wt) => ({ threadId: "thread-os1", projectId: "proj-0", title: "OS-1 a fix", status: "running", worktreePath: wt, branch: "os-1", settled: false, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: "run-1", latestRunId: "run-1" }));
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps).toEqual([expect.objectContaining({ id: 7, outcome: "launched", t3_thread_id: "thread-os1", t3_run_id: "run-1", base_sha: "fork1" })]);
    expect(s.lands).toEqual([]);
  }, spawnBudget(4));

  test("a settled thread is still the row's builder and is recorded", async () => {
    // The close or the OS-288 sweep settled the finished builder's thread before reconcile ran.
    const worktree = verdictRow((wt) => ({ threadId: "thread-done", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-9", createdAt: "2026-08-19T00:01:00.000Z" }));
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps).toEqual([expect.objectContaining({ id: 7, outcome: "launched", t3_thread_id: "thread-done", t3_run_id: "run-9" })]);
  }, spawnBudget(4));

  test("a live thread wins over a settled one from an earlier attempt on the same worktree", async () => {
    const worktree = verdictRow((wt) => ({ threadId: "thread-old", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-0" }), (wt) => ({ threadId: "thread-live", projectId: "proj-0", title: "OS-1 a fix", status: "running", worktreePath: wt, branch: "os-1", settled: false, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: "run-2", latestRunId: "run-2" }));
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps).toEqual([expect.objectContaining({ id: 7, outcome: "launched", t3_thread_id: "thread-live", t3_run_id: "run-2" })]);
  }, spawnBudget(4));

  test("two attempts on one worktree, and a relaunch of this row: the newest thread created after the row is recorded whatever T3's list order (OS-302)", async () => {
    // T3 lists the earlier failed attempt's thread first; this row's own threads come after it, newest in the middle.
    const worktree = verdictRow(
      (wt) => ({ threadId: "thread-attempt-1", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-a1", createdAt: "2026-08-18T10:00:00.000Z" }),
      (wt) => ({ threadId: "thread-first-launch", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-f", createdAt: "2026-08-19T00:01:00.000Z" }),
      (wt) => ({ threadId: "thread-relaunch", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-r", createdAt: "2026-08-19T00:07:00.000Z" }),
      (wt) => ({ threadId: "thread-mid", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-m", createdAt: "2026-08-19T00:03:00.000Z" }),
    );
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps).toEqual([expect.objectContaining({ id: 7, outcome: "launched", t3_thread_id: "thread-relaunch", t3_run_id: "run-r" })]);
  }, spawnBudget(4));

  test("a thread T3 dates up to a minute before the row still counts: the queue and T3 may run on different clocks (OS-302)", async () => {
    const worktree = verdictRow((wt) => ({ threadId: "thread-skewed", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-s", createdAt: "2026-08-18T23:59:30.000Z" }));
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps).toEqual([expect.objectContaining({ id: 7, outcome: "launched", t3_thread_id: "thread-skewed", t3_run_id: "run-s" })]);
  }, spawnBudget(4));

  test("an archived thread is passed over even when it is the newest on the worktree (OS-302)", async () => {
    const worktree = verdictRow(
      // T3 lists the archived newest thread first, so taking the first listed would record it.
      (wt) => ({ threadId: "thread-archived", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: true, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-x", createdAt: "2026-08-19T00:09:00.000Z" }),
      (wt) => ({ threadId: "thread-kept", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-k", createdAt: "2026-08-19T00:05:00.000Z" }),
    );
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps).toEqual([expect.objectContaining({ id: 7, outcome: "launched", t3_thread_id: "thread-kept", t3_run_id: "run-k" })]);
  }, spawnBudget(4));

  test("a thread T3 dates more than a minute before the row is an earlier attempt's, so the row ends failed (OS-302)", async () => {
    // 61s before request_at: just outside the skew window, so a widened or dropped lower bound would record it.
    const worktree = verdictRow((wt) => ({ threadId: "thread-too-early", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-e", createdAt: "2026-08-18T23:58:59.000Z" }));
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps.map((b) => [b.id, b.outcome])).toEqual([[7, "failed"]]);
    expect(String(s.stamps[0]!.error)).toContain("T3 holds no thread");
  }, spawnBudget(4));

  test("a settled thread with no createdAt alone on the worktree is not this row's builder, so the row ends failed (OS-302)", async () => {
    const worktree = verdictRow((wt) => ({ threadId: "thread-undated", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-u" }));
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps.map((b) => [b.id, b.outcome])).toEqual([[7, "failed"]]);
    expect(String(s.stamps[0]!.error)).toContain("T3 holds no thread");
  }, spawnBudget(4));

  test("only an earlier attempt's settled thread on the worktree is not this row's builder, so the row ends failed (OS-302)", async () => {
    const worktree = verdictRow((wt) => ({ threadId: "thread-attempt-1", projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: wt, branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-a1", createdAt: "2026-08-18T10:00:00.000Z" }));
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps.map((b) => [b.id, b.outcome])).toEqual([[7, "failed"]]);
    expect(String(s.stamps[0]!.error)).toContain("T3 holds no thread");
  }, spawnBudget(4));

  test("with no thread at all on its worktree it ends failed, naming the branch that keeps the work", async () => {
    const worktree = verdictRow();
    const s = server([row({ worktree })], { leases: [] });
    await reconcile(s);
    expect(s.stamps.map((b) => [b.id, b.outcome])).toEqual([[7, "failed"]]);
    expect(String(s.stamps[0]!.error)).toContain("T3 holds no thread");
    expect(String(s.stamps[0]!.error)).toContain("os-1");
  }, spawnBudget(4));
});

// OS-226: the apiReconcile path abandons a building t3 row whose builder thread ended with no handoff and no verdict.
import { afterEach, describe, expect, test } from "bun:test";
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


describe("apiReconcile abandons a building row whose builder thread ended (OS-226)", () => {
  function settledThread(threadId: string, over: Record<string, unknown> = {}) {
    const t3 = installFakeT3([REPO]);
    cleanups.push(t3.restore);
    t3.threads.push({ threadId, projectId: "proj-0", title: "OS-1 a fix", status: "idle", worktreePath: "/nonexistent/os226", branch: "os-1", settled: true, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-1", ...over } as never);
  }

  test("a settled thread with no handoff and no verdict: the row is stamped failed as abandoned", async () => {
    cleanups.push(git(false));
    settledThread("thread-os1");
    const s = server([row({ status: "launched", t3_thread_id: "thread-os1", worktree: "/nonexistent/os226" })], { leases: [] });
    const r = await reconcile(s);
    expect(s.stamps.map((b) => [b.id, b.outcome])).toEqual([[7, "failed"]]);
    expect(String(s.stamps[0]!.error)).toStartWith("abandoned:");
    expect(String(s.stamps[0]!.error)).toContain("thread-os1 was settled with no handoff");
    expect(r.out).toContain(`  ✗ OS-1: ${String(s.stamps[0]!.error)}`);
  }, spawnBudget(4));
});

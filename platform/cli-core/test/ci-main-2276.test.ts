// OB-2276: GitHub webhooks into ob, and a red run on `main` tells the team's sentinel.
// The receiver is driven through `createObApi` with real signed Requests on a throwaway SQLite store, the
// catch-up and the hooks plan through `runCli` with a fake GitHub REST reader and a fake T3 seam, and the claim
// (insert, conflict does nothing, returning) once more on a real Postgres store. Repos and threads are invented.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore, openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX, OB_API_ROUTES } from "../../../apps/cli/src/api/contract.ts";
import { setSecret } from "../../../apps/cli/src/secrets.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { computeAlerts } from "../../../apps/cli/src/commands/alerts.ts";
import {
  __setCiRetryMs,
  __setGithubRest,
  GITHUB_WEBHOOK_PATH,
  HOOK_EVENTS,
  handleRun,
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_SECRET_NAME,
  type CiRun,
  type GithubRest,
} from "../../../apps/cli/src/ci-main.ts";
import { storeAgentRegistry, __setT3Seam, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { migratedDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";

const HOOK_URL = "https://ob-api.test/api/ob/github/webhook";

const SECRET = "test-webhook-secret";
const TOKEN = "test-api-token";
const KEY = randomBytes(32);
const AT = "2026-11-17T00:00:00Z";

// --- fixtures ---------------------------------------------------------------------------------------------

/** acme/app is in team `acme` (sentinel thread thr-s, architect thread thr-a, never told); lone/site is in no team. */
function seed(db: ReturnType<typeof openDb>): void {
  db.query("INSERT INTO project_group (name, created_at) VALUES ('acme', ?)").run(AT);
  db.query("INSERT INTO project (id, name, kind, git_remote, created_at, group_name) VALUES ('app', 'app', 'side', 'git@github.com:acme/app.git', ?, 'acme')").run(AT);
  db.query("INSERT INTO project (id, name, kind, git_remote, created_at) VALUES ('site', 'site', 'side', 'https://github.com/lone/site.git', ?)").run(AT);
  db.query("INSERT INTO project (id, name, kind, created_at) VALUES ('notes', 'notes', 'home', ?)").run(AT);
  const agent = db.query(
    "INSERT INTO agent (id, worktree, started_at, heartbeat_at, ttl_s, launcher, session_id) VALUES (?, '/x', ?, ?, 86400, 't3', ?)",
  );
  agent.run("architect-acme", AT, AT, "thr-a");
  agent.run("sentinel-acme", AT, AT, "thr-s");
}

interface Sent {
  threadId: string;
  message: string;
  clientRequestId?: string;
}

/** A T3 seam that records each send; `fail` makes every send throw. */
function fakeSeam(state: { sent: Sent[]; fail: boolean }): T3Seam {
  return {
    send: async (input: Sent) => {
      if (state.fail) throw new Error("connection refused");
      state.sent.push({ threadId: input.threadId, message: input.message, ...(input.clientRequestId !== undefined ? { clientRequestId: input.clientRequestId } : {}) });
    },
  } as unknown as T3Seam;
}

function rawRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 100,
    name: "CI",
    workflow_id: 7,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "failure",
    head_sha: "abcdef1234567890",
    head_commit: { message: "feat(AC-1): add the thing\n\nbody" },
    html_url: "https://github.com/acme/app/actions/runs/100",
    created_at: AT,
    repository: { full_name: "acme/app" },
    ...over,
  };
}

/** A REST reader serving the jobs of any run, a per-repo run list, and hooks; records writes. */
function fakeRest(state: { runs?: Record<string, unknown[]>; hooks?: Record<string, unknown[]>; writes: string[]; failRepo?: string }): GithubRest {
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method !== "GET") {
        state.writes.push(`${method} ${path} ${JSON.stringify(body)}`);
        return { id: 9 } as T;
      }
      if (state.failRepo && path.startsWith(`/repos/${state.failRepo}/`)) throw new Error(`GitHub GET ${path} -> 404 (Not Found)`);
      if (/\/actions\/runs\/\d+\/jobs/.test(path)) {
        return { jobs: [{ name: "gate", conclusion: "failure" }, { name: "lint", conclusion: "success" }, { name: "e2e", conclusion: "timed_out" }] } as T;
      }
      const m = path.match(/^\/repos\/([^/]+\/[^/]+)\/(actions\/runs|hooks)/);
      if (m && m[2] === "actions/runs") return { workflow_runs: state.runs?.[m[1]!] ?? [] } as T;
      if (m && m[2] === "hooks") return (state.hooks?.[m[1]!] ?? []) as T;
      throw new Error(`unexpected GET ${path}`);
    },
  };
}

interface Rig {
  db: ReturnType<typeof openDb>;
  dbPath: string;
  store: Store;
  sent: Sent[];
  t3: { sent: Sent[]; fail: boolean };
  rest: { runs: Record<string, unknown[]>; hooks: Record<string, unknown[]>; writes: string[]; failRepo?: string };
  pending: Promise<void>[];
  post(event: string, delivery: string, payload: unknown, signature?: string | null): Promise<{ status: number; body: any }>;
  settle(): Promise<void>;
}

let restores: Array<() => void> = [];
afterEach(() => {
  for (const r of restores.reverse()) r();
  restores = [];
});

async function rig(opts: { secret?: boolean } = {}): Promise<Rig> {
  const dbPath = migratedDbPath();
  const db = openDb(dbPath);
  seed(db);
  const store = asStore(db);
  if (opts.secret !== false) await setSecret(store, WEBHOOK_SECRET_NAME, SECRET, KEY);
  await setConfig(db, "github_webhook_url", HOOK_URL);
  const t3 = { sent: [] as Sent[], fail: false };
  const rest = { runs: {} as Record<string, unknown[]>, hooks: {} as Record<string, unknown[]>, writes: [] as string[] };
  const pending: Promise<void>[] = [];
  const seam = fakeSeam(t3);
  restores.push(__setCiRetryMs(0), __setT3Seam(seam), __setGithubRest(fakeRest(rest)));
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere", reason: null, message: null }),
    secrets: { masterKey: { get: () => KEY } },
    ci: { sleep: async () => {}, defer: (w) => void pending.push(w()) },
  });
  const r: Rig = {
    db,
    dbPath,
    store,
    get sent() {
      return t3.sent;
    },
    t3,
    rest,
    pending,
    async post(event, delivery, payload, signature) {
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery };
      const sig = signature === undefined ? signWebhookBody(SECRET, body) : signature;
      if (sig !== null) headers["x-hub-signature-256"] = sig;
      const res = await api(new Request(`https://ob.test${GITHUB_WEBHOOK_PATH}`, { method: "POST", headers, body }));
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async settle() {
      await Promise.all(pending.splice(0));
    },
  };
  return r;
}

const count = (db: ReturnType<typeof openDb>, table: string): number => (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function runEvent(over: Record<string, unknown> = {}, action = "completed") {
  return { action, workflow_run: rawRun(over), repository: { full_name: (over.repository as { full_name?: string })?.full_name ?? "acme/app" } };
}

// --- 1. the receiver -----------------------------------------------------------------------------------------

describe("the receiver (Done when 1)", () => {
  test("the route is the exact path under the API prefix, and is listed", () => {
    expect(GITHUB_WEBHOOK_PATH).toBe(`${OB_API_PREFIX}/github/webhook`);
    expect(OB_API_ROUTES.some((r) => r.method === "POST" && r.path === "/github/webhook")).toBe(true);
  });

  test("signature: good, wrong, missing, malformed", () => {
    const body = '{"a":1}';
    expect(verifyWebhookSignature(SECRET, body, signWebhookBody(SECRET, body))).toBe(true);
    expect(verifyWebhookSignature(SECRET, body, signWebhookBody("other", body))).toBe(false);
    expect(verifyWebhookSignature(SECRET, body + " ", signWebhookBody(SECRET, body))).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, null)).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "sha256=zz")).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "sha1=" + "0".repeat(40))).toBe(false);
  });

  test("a signed request needs no bearer token: 202, ping 200; unsigned or wrong is 401 and records nothing", async () => {
    const r = await rig();
    expect((await r.post("ping", "d-ping", { zen: "hi" })).status).toBe(200);
    expect((await r.post("push", "d-push", { ref: "refs/heads/main" })).status).toBe(202);
    const before = count(r.db, "github_delivery");
    const events = count(r.db, "event");
    expect((await r.post("push", "d-nosig", { ref: "x" }, null)).status).toBe(401);
    const wrong = await r.post("push", "d-wrong", { ref: "x" }, signWebhookBody("not-the-secret", '{"ref":"x"}'));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("unauthorized");
    expect(count(r.db, "github_delivery")).toBe(before);
    expect(count(r.db, "event")).toBe(events);
    // Any OTHER path still needs the bearer: the exception is the one route.
    const api = createObApi({ store: async () => r.store, token: () => ({ token: TOKEN, path: "/x", reason: null, message: null }) });
    expect((await api(new Request(`https://ob.test${OB_API_PREFIX}/github/hooks`, { method: "GET" }))).status).toBe(401);
    expect((await api(new Request(`https://ob.test${GITHUB_WEBHOOK_PATH}`, { method: "GET" }))).status).toBe(401);
  });

  test("the same delivery id twice is recorded once, and acts once", async () => {
    const r = await rig();
    expect((await r.post("workflow_run", "d-1", runEvent())).status).toBe(202);
    const again = await r.post("workflow_run", "d-1", runEvent());
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    await r.settle();
    expect(count(r.db, "github_delivery")).toBe(1);
    expect((r.db.query("SELECT count(*) AS n FROM event WHERE source = 'github' AND type = 'webhook:workflow_run'").get() as { n: number }).n).toBe(1);
    expect(r.sent).toHaveLength(1);
  });

  test("with no webhook secret stored the receiver answers 503 and records nothing", async () => {
    const r = await rig({ secret: false });
    expect((await r.post("ping", "d-x", {})).status).toBe(503);
    expect(count(r.db, "github_delivery")).toBe(0);
  });
});

// --- 2, 3. telling ---------------------------------------------------------------------------------------------

describe("a red run on main (Done when 2)", () => {
  test("told once to the sentinel, with repo, workflow, SHA, subject, failing jobs and URL", async () => {
    const r = await rig();
    await r.post("workflow_run", "d-1", runEvent());
    await r.settle();
    expect(r.sent).toHaveLength(1);
    const note = r.sent[0]!;
    expect(note.threadId).toBe("thr-s");
    expect(note.clientRequestId).toBe("ob-ci-red-100");
    for (const want of ["acme/app", "CI", "abcdef1", "feat(AC-1): add the thing", "gate, e2e", "https://github.com/acme/app/actions/runs/100", "failure"]) {
      expect(note.message).toContain(want);
    }
    expect(note.message).not.toContain("lint");
    // A second delivery of the same run (a new delivery id) tells nobody.
    await r.post("workflow_run", "d-2", runEvent());
    await r.settle();
    expect(r.sent).toHaveLength(1);
  });

  test("with no sentinel thread the architect is never told, though its thread is bound (OS-181)", async () => {
    const r = await rig();
    r.db.query("DELETE FROM agent WHERE id = 'sentinel-acme'").run();
    await r.post("workflow_run", "d-1", runEvent({ conclusion: "timed_out" }));
    await r.settle();
    expect(r.sent).toHaveLength(0);
    expect(count(r.db, "ci_main_notice")).toBe(0);
  });

  test("a green whose sentinel has ended recovers the red, tells nobody and starts nothing (OS-181)", async () => {
    const r = await rig();
    await r.post("workflow_run", "d-1", runEvent());
    await r.settle();
    r.db.query("DELETE FROM agent WHERE id = 'sentinel-acme'").run();
    await r.post("workflow_run", "d-2", runEvent({ id: 101, conclusion: "success" }));
    await r.settle();
    expect(r.sent.map((s) => s.threadId)).toEqual(["thr-s"]);
    expect((await computeAlerts(r.store, { focusProject: null })).filter((a) => a.rule === 12)).toHaveLength(0);
  });

  test("the catch-up's start seam: no sentinel thread starts one and tells it; a failed start tells nobody (OS-181)", async () => {
    const r = await rig();
    r.db.query("DELETE FROM agent WHERE id = 'sentinel-acme'").run();
    const run: CiRun = { runId: "100", repo: "acme/app", workflowId: "7", workflow: "CI", branch: "main", event: "push", conclusion: "failure", sha: "abc", subject: "s", url: "u" };
    const base = { rest: fakeRest({ writes: [] }), registry: storeAgentRegistry(r.store), seam: fakeSeam(r.t3), sleep: async () => {} };
    const refused = await handleRun(r.store, run, { ...base, start: async () => { throw new Error("T3 down"); } });
    expect(refused.action).toBe("failed");
    expect(refused.reason).toContain("the acme sentinel could not start (T3 down)");
    expect(refused.reason).toContain("ob role start acme sentinel");
    expect(r.sent).toHaveLength(0);
    expect(count(r.db, "ci_main_notice")).toBe(0);
    const started: string[] = [];
    const told = await handleRun(r.store, run, { ...base, start: async (team) => { started.push(team); return "thr-new"; } });
    expect(told).toMatchObject({ action: "told", target: "sentinel-acme" });
    expect(started).toEqual(["acme"]);
    expect(r.sent.map((s) => s.threadId)).toEqual(["thr-new"]);
    // The hourly catch-up re-reads a red run already told: that starts nothing, even with the sentinel ended again.
    expect((await handleRun(r.store, run, { ...base, start: async (team) => { started.push(team); return "thr-2"; } })).action).toBe("already");
    expect(started).toEqual(["acme"]);
  });

  test("startup_failure is red; cancelled, another branch and a PR run tell nobody", async () => {
    const r = await rig();
    await r.post("workflow_run", "d-1", runEvent({ id: 101, conclusion: "cancelled" }));
    await r.post("workflow_run", "d-2", runEvent({ id: 102, head_branch: "feature" }));
    await r.post("workflow_run", "d-3", runEvent({ id: 103, event: "pull_request" }));
    await r.post("workflow_run", "d-4", runEvent({ id: 104 }, "requested"));
    await r.settle();
    expect(r.sent).toHaveLength(0);
    expect(count(r.db, "ci_main_notice")).toBe(0);
    await r.post("workflow_run", "d-5", runEvent({ id: 105, conclusion: "startup_failure" }));
    await r.settle();
    expect(r.sent).toHaveLength(1);
  });
});

describe("recovery (Done when 3)", () => {
  test("the first green after a told failure sends one line; a second green sends nothing", async () => {
    const r = await rig();
    await r.post("workflow_run", "d-1", runEvent({ id: 100 }));
    await r.post("workflow_run", "d-2", runEvent({ id: 101, conclusion: "success", head_sha: "1234567aaaa" }));
    await r.settle();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]!.message).toContain("main is green again: acme/app · CI at 1234567");
    expect(r.sent[1]!.clientRequestId).toBe("ob-ci-green-101");
    await r.post("workflow_run", "d-3", runEvent({ id: 102, conclusion: "success" }));
    await r.settle();
    expect(r.sent).toHaveLength(2);
  });

  test("a re-run of the red run that passes (same run id, a later attempt) recovers it", async () => {
    const r = await rig();
    await r.post("workflow_run", "d-1", runEvent({ id: 100, run_attempt: 1 }));
    await r.post("workflow_run", "d-2", runEvent({ id: 100, run_attempt: 2, conclusion: "success" }));
    await r.settle();
    expect(r.sent.map((s) => s.clientRequestId)).toEqual(["ob-ci-red-100", "ob-ci-green-100"]);
    expect((await computeAlerts(r.store, { focusProject: null })).filter((a) => a.rule === 12)).toHaveLength(0);
  });

  test("a team with no thread yet is a failed route: no row, and the catch-up tells it once the thread is up", async () => {
    const r = await rig();
    r.db.query("UPDATE agent SET session_id = NULL WHERE id = 'sentinel-acme'").run();
    await r.post("workflow_run", "d-1", runEvent());
    await r.settle();
    expect(count(r.db, "ci_main_notice")).toBe(0);
    r.db.query("UPDATE agent SET session_id = 'thr-s' WHERE id = 'sentinel-acme'").run();
    r.rest.runs["acme/app"] = [rawRun()];
    expect((await runCli(r.dbPath, ["ci", "main", "--notify"])).code).toBe(0);
    expect(r.sent.map((s) => s.threadId)).toEqual(["thr-s"]);
  });

  test("an oversized webhook body is refused unread past the cap, with or without a content-length", async () => {
    const r = await rig();
    const big = "x".repeat(5_000_001);
    const api = createObApi({ store: async () => r.store, token: () => ({ token: TOKEN, path: "/x", reason: null, message: null }), secrets: { masterKey: { get: () => KEY } } });
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const res = await api(new Request(`https://ob.test${GITHUB_WEBHOOK_PATH}`, { method: "POST", headers: { "x-github-event": "ping", "x-github-delivery": "d-big", "x-hub-signature-256": signWebhookBody(SECRET, big) }, body: stream }));
    expect(res.status).toBe(413);
    expect(count(r.db, "github_delivery")).toBe(0);
  });

  test("a green with no told failure, or an older green arriving late, sends nothing", async () => {
    const r = await rig();
    await r.post("workflow_run", "d-1", runEvent({ id: 90, conclusion: "success" }));
    await r.post("workflow_run", "d-2", runEvent({ id: 100 }));
    await r.post("workflow_run", "d-3", runEvent({ id: 99, conclusion: "success" }));
    await r.settle();
    expect(r.sent).toHaveLength(1); // the red only
    // Another workflow's green does not recover this one.
    await r.post("workflow_run", "d-4", runEvent({ id: 120, workflow_id: 8, name: "Docs", conclusion: "success" }));
    await r.settle();
    expect(r.sent).toHaveLength(1);
  });
});

// --- 4. a failed route, and the catch-up -------------------------------------------------------------------

describe("a failed send and the catch-up (Done when 4)", () => {
  test("a failed send records nothing; ob ci main --notify then sends that run once", async () => {
    const r = await rig();
    r.t3.fail = true;
    await r.post("workflow_run", "d-1", runEvent());
    await r.settle();
    expect(count(r.db, "ci_main_notice")).toBe(0);
    expect(r.sent).toHaveLength(0);

    r.t3.fail = false;
    r.rest.runs["acme/app"] = [rawRun(), rawRun({ id: 98, conclusion: "success" }), rawRun({ id: 97, workflow_id: 8, name: "Docs", conclusion: "success" })];
    const first = await runCli(r.dbPath, ["ci", "main", "--notify"], {});
    expect(first.code).toBe(0);
    expect(first.out).toContain("notify: told acme/app · CI run 100 -> sentinel-acme");
    expect(r.sent).toHaveLength(1);
    const second = await runCli(r.dbPath, ["ci", "main", "--notify"], {});
    expect(second.code).toBe(0);
    expect(second.out).toContain("notify: nothing to send");
    expect(r.sent).toHaveLength(1);
  });

  test("a send that still fails exits 1 so the job is a JOB FAILING alert", async () => {
    const r = await rig();
    r.t3.fail = true;
    r.rest.runs["acme/app"] = [rawRun()];
    const res = await runCli(r.dbPath, ["ci", "main", "--notify"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("notify: failed acme/app · CI run 100");
    expect(count(r.db, "ci_main_notice")).toBe(0);
  });

  test("ob ci main lists the latest push run per workflow; a repo with none, or no remote, is a named line", async () => {
    const r = await rig();
    r.rest.runs["acme/app"] = [
      rawRun({ id: 100, conclusion: "success" }),
      rawRun({ id: 99, conclusion: "failure" }),
      rawRun({ id: 98, workflow_id: 8, name: "Docs", conclusion: "success" }),
      rawRun({ id: 97, head_branch: "main", event: "workflow_dispatch", workflow_id: 9, name: "Manual" }),
    ];
    const res = await runCli(r.dbPath, ["ci", "main"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("app (acme/app)");
    expect(res.out).toMatch(/CI\s+success\s+abcdef1/);
    expect(res.out).toMatch(/Docs\s+success/);
    expect(res.out).not.toContain("Manual");
    expect(res.out).not.toMatch(/CI\s+failure/);
    expect(res.out).toContain("site: no runs on main");
    expect(res.out).toContain("notes: no GitHub remote recorded");
    expect(r.sent).toHaveLength(0); // without --notify nothing is sent

    const json = JSON.parse((await runCli(r.dbPath, ["ci", "main", "--json", "--project", "app"])).out);
    expect(json).toHaveLength(1);
    expect(json[0].runs.map((x: CiRun) => x.workflow)).toEqual(["CI", "Docs"]);

    r.rest.failRepo = "lone/site";
    const failed = await runCli(r.dbPath, ["ci", "main"]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("site: could not read: GitHub GET");
    expect((await runCli(r.dbPath, ["ci", "main", "--yes"])).code).toBe(2);
  });
});

// --- 5. a project in no team -------------------------------------------------------------------------------

describe("a project in no team (Done when 5)", () => {
  test("no thread note, and the red run is an alert until it recovers", async () => {
    const r = await rig();
    const site = (over: Record<string, unknown>) => runEvent({ repository: { full_name: "lone/site" }, html_url: "https://github.com/lone/site/actions/runs/1", ...over });
    await r.post("workflow_run", "d-1", site({ id: 200 }));
    await r.settle();
    expect(r.sent).toHaveLength(0);
    let alerts = (await computeAlerts(r.store, { focusProject: null })).filter((a) => a.rule === 12);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.entity).toBe("lone/site · CI");
    expect(alerts[0]!.message).toContain("https://github.com/lone/site/actions/runs/1");
    expect(alerts[0]!.message).toContain("nobody was told");
    expect(alerts[0]!.message).toContain("in no team");

    await r.post("workflow_run", "d-2", site({ id: 201, conclusion: "success" }));
    await r.settle();
    expect(r.sent).toHaveLength(0);
    alerts = (await computeAlerts(r.store, { focusProject: null })).filter((a) => a.rule === 12);
    expect(alerts).toHaveLength(0);
  });

  test("a team project's told red is an alert too, naming who was told", async () => {
    const r = await rig();
    await r.post("workflow_run", "d-1", runEvent());
    await r.settle();
    const alerts = (await computeAlerts(r.store, { focusProject: null })).filter((a) => a.rule === 12);
    expect(alerts.map((a) => a.message)).toEqual([expect.stringContaining("told sentinel-acme")]);
  });
});

// --- 6. hooks ----------------------------------------------------------------------------------------------

describe("ob github hooks (Done when 6)", () => {
  test("without --yes it prints the plan per project and writes nothing", async () => {
    const r = await rig();
    r.rest.hooks["lone/site"] = [
      { id: 5, active: true, events: ["workflow_run"], config: { url: HOOK_URL, content_type: "json" } },
    ];
    const res = await runCli(r.dbPath, ["github", "hooks"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/app\s+acme\/app\s+would create: events workflow_run, check_suite, pull_request, push/);
    expect(res.out).toMatch(/site\s+lone\/site\s+would fix: missing events check_suite, pull_request, push/);
    expect(res.out).toMatch(/notes\s+-\s+skip: no GitHub remote recorded/);
    expect(res.out).toContain("dry run: 2 hook(s) to create or fix; nothing changed");
    expect(r.rest.writes).toEqual([]);

    r.rest.hooks["lone/site"]![0] = { ...(r.rest.hooks["lone/site"]![0] as object), events: [...HOOK_EVENTS] };
    r.rest.hooks["acme/app"] = [r.rest.hooks["lone/site"]![0]!];
    const ok = await runCli(r.dbPath, ["github", "hooks", "--json"]);
    expect(JSON.parse(ok.out).filter((x: { action: string }) => x.action === "ok")).toHaveLength(2);
  });

  test("--yes creates and fixes, signed with the secret; the plan is served over the API", async () => {
    const r = await rig();
    r.rest.hooks["lone/site"] = [{ id: 5, active: false, events: [...HOOK_EVENTS], config: { url: HOOK_URL, content_type: "json" } }];
    const api = createObApi({
      store: async () => r.store,
      token: () => ({ token: TOKEN, path: "/x", reason: null, message: null }),
      secrets: { masterKey: { get: () => KEY } },
    });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const plan: any = await (await api(new Request(`https://ob.test${OB_API_PREFIX}/github/hooks`, { headers: auth }))).json();
    expect(plan.dry_run).toBe(true);
    expect(r.rest.writes).toEqual([]);
    const applied: any = await (await api(new Request(`https://ob.test${OB_API_PREFIX}/github/hooks`, { method: "POST", headers: auth }))).json();
    expect(applied.rows.map((x: { action: string }) => x.action).sort()).toEqual(["created", "fixed", "skip"]);
    expect(r.rest.writes).toHaveLength(2);
    expect(r.rest.writes[0]).toContain(`"secret":"${SECRET}"`);
    expect(r.rest.writes.find((w) => w.startsWith("PATCH /repos/lone/site/hooks/5"))).toBeDefined();
  });
});

// --- 7. the job --------------------------------------------------------------------------------------------

describe("the ci-main job (Done when 7)", () => {
});

// --- the claim on Postgres ---------------------------------------------------------------------------------

describe("on Postgres", () => {
  let store: Store;
  beforeEach(async () => {
    const lease = await leaseRealPgDb();
    store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  });

  test("a run is claimed once and a failed send removes the claim", async () => {
    const t3 = { sent: [] as Sent[], fail: true };
    const seam = fakeSeam(t3);
    await store.q.insert(store.t.team).values({ name: "acme", created_at: AT });
    await store.q.insert(store.t.project).values({ id: "app", name: "app", kind: "side", git_remote: "git@github.com:acme/app.git", created_at: AT, team_name: "acme" });
    await store.q.insert(store.t.agent).values({ id: "sentinel-acme", worktree: "/x", started_at: AT, heartbeat_at: AT, ttl_s: 86400, launcher: "t3", session_id: "thr-s" } as never);
    const deps = { rest: fakeRest({ writes: [] }), registry: storeAgentRegistry(store), seam, sleep: async () => {} };
    const run: CiRun = { runId: "100", repo: "acme/app", workflowId: "7", workflow: "CI", branch: "main", event: "push", conclusion: "failure", sha: "abc", subject: "s", url: "u" };
    expect((await handleRun(store, run, deps)).action).toBe("failed");
    expect(await store.q.select().from(store.t.ciMainNotice)).toHaveLength(0);
    t3.fail = false;
    const [a, b] = await Promise.all([handleRun(store, run, deps), handleRun(store, run, deps)]);
    expect([a.action, b.action].sort()).toEqual(["already", "told"]);
    expect(t3.sent).toHaveLength(1);
    const green = { ...run, runId: "101", conclusion: "success" };
    expect((await handleRun(store, green, deps)).action).toBe("recovered");
    expect((await handleRun(store, { ...green, runId: "102" }, deps)).action).toBe("ignored");
    expect(t3.sent).toHaveLength(2);
  });
});

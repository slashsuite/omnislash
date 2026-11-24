// OS-179: a scoped API token writes items, runs spinoffs and speaks for team roles, all filtered to its projects.
//
// Over a REAL Postgres store (the ob 325 harness), like OS-178's test: every filter is asserted on the rows
// that come back and every refusal on its status, and the 404 for a hidden row is compared with the 404 for a
// missing one.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_ADMIN_FAMILIES, OB_API_PREFIX, OB_API_ROUTES, OB_API_SCOPABLE_FAMILIES } from "../../../apps/cli/src/api/contract.ts";
import { loadScopedTokens, sha256Hex, type ScopedTokenEntry } from "../../../apps/cli/src/api/scoped-tokens.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { addTeam } from "../../../apps/cli/src/team.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { acquireLease } from "../../../platform/cli-coord/src/lease.ts";
import { registerAgent } from "../../../platform/cli-coord/src/agent.ts";
import { enqueueSpinoff } from "../../../platform/cli-coord/src/commands/spinoff.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";

const ADMIN = "an-admin-bearer-token-that-is-long-enough";
const ERIN = "erin-scoped-token-0123456789abcdef0123456789ab";
const BUDGET = spawnBudget(4);

const scratch = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "ob-scoped-179-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function tokensFile(entries: ScopedTokenEntry[]): string {
  const path = join(scratch, `tokens-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(entries));
  chmodSync(path, 0o600);
  return path;
}

const erin: ScopedTokenEntry = { user: "erin", sha256: sha256Hex(ERIN), projects: ["alpha"], families: [...OB_API_SCOPABLE_FAMILIES] };

type Call = (path: string, opts?: { method?: string; token?: string | null; body?: unknown }) => Promise<{ status: number; body: any; text: string }>;

interface Fixture {
  store: Store;
  call: Call;
  /** a1, a2 in alpha; b1 in beta. Refs are what a client asks by. */
  a1: string;
  a2: string;
  b1: string;
}

async function withScopedApi(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const path = tokensFile([erin]);
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: ADMIN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    scopedTokens: () => loadScopedTokens(path),
  });
  try {
    await registerProject(store, { name: "alpha", kind: "side" });
    await registerProject(store, { name: "beta", kind: "side" });
    const ref = async (id: string) => (await getItem(store, id))?.ref ?? id;
    const a1 = await ref(await createItem(store, { type: "task", title: "alpha one", projectId: "alpha" }));
    const a2 = await ref(await createItem(store, { type: "task", title: "alpha two", projectId: "alpha" }));
    const b1 = await ref(await createItem(store, { type: "task", title: "beta secret", projectId: "beta" }));
    const call: Call = async (p, opts = {}) => {
      const headers: Record<string, string> = {};
      const token = opts.token === undefined ? ERIN : opts.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const res = await api(
        new Request(`http://api-host.local${OB_API_PREFIX}${p}`, {
          method: opts.method ?? "GET",
          headers,
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        }),
      );
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { html: true };
      }
      return { status: res.status, body, text };
    };
    await fn({ store, call, a1, a2, b1 });
  } finally {
    await store.close();
    await lease.release();
  }
}

const post = (body: unknown) => ({ method: "POST", body });
const concrete = (pattern: string) => pattern.replace(/:[^/]+/g, "x");
const UNAUTHENTICATED = new Set(["GET /google/auth", "GET /google/callback", "POST /github/webhook"]);

describe("route grants (OS-179)", () => {
  test("no admin-family route carries `scoped`, and every marked route is in a scopable family", () => {
    const admin = new Set(OB_API_ADMIN_FAMILIES);
    const wrong = OB_API_ROUTES.filter((r) => r.scoped !== undefined && admin.has(r.family)).map((r) => `${r.method} ${r.path}`);
    expect(wrong).toEqual([]);
    const readWrites = OB_API_ROUTES.filter((r) => r.scoped === "read" && r.method !== "GET").map((r) => `${r.method} ${r.path}`);
    expect(readWrites).toEqual([]);
    for (const f of ["spinoffs", "agents", "leases", "teams", "decisions"]) {
      expect(OB_API_SCOPABLE_FAMILIES).toContain(f);
      expect(OB_API_ADMIN_FAMILIES).not.toContain(f);
    }
  });

  test("the admin-only routes of opened families stay unmarked", () => {
    const marked = (m: string, p: string) => OB_API_ROUTES.find((r) => r.method === m && r.path === p)?.scoped;
    for (const [m, p] of [
      ["DELETE", "/items/:id"],
      ["POST", "/spinoffs/reclaim"],
      ["POST", "/spinoffs/reopen"],
      ["POST", "/spinoffs/trial"],
      ["POST", "/agents/reset"],
      ["POST", "/leases/sweep"],
      ["POST", "/teams"],
      ["POST", "/teams/:name/edit"],
      ["POST", "/teams/:name/join"],
      ["POST", "/teams/leave"],
      ["DELETE", "/teams/:name"],
      ["POST", "/decisions/supersede"],
    ] as const) {
      expect(marked(m, p), `${m} ${p}`).toBeUndefined();
    }
  });

  test(
    "every route: unmarked is 403, read-marked is never reachable by a write, write-marked passes the gate",
    async () => {
      await withScopedApi(async ({ call }) => {
        for (const r of OB_API_ROUTES) {
          if (UNAUTHENTICATED.has(`${r.method} ${r.path}`)) continue;
          const res = await call(concrete(r.path), { method: r.method, ...(r.method === "POST" ? { body: {} } : {}) });
          if (r.scoped === undefined || !OB_API_SCOPABLE_FAMILIES.includes(r.family)) {
            expect(res.status, `${r.method} ${r.path}`).toBe(403);
            expect(res.body.error.code).toBe("forbidden");
          } else {
            expect(res.status, `${r.method} ${r.path}: ${res.text}`).not.toBe(403);
            expect(res.status, `${r.method} ${r.path}: ${res.text}`).toBeLessThan(500);
          }
        }
        // A read-marked route answers a write with 403: the write half of GET /items/:id is DELETE.
        expect((await call("/items/x", { method: "DELETE" })).status).toBe(403);
        expect((await call("/spinoffs/config", post({}))).status).toBe(403);
      });
    },
    BUDGET,
  );
});

describe("item writes through a scoped token (OS-179)", () => {
  test(
    "writes work in an allowed project; the same calls on a disallowed item are 404; DELETE is 403",
    async () => {
      await withScopedApi(async ({ store, call, a1, a2, b1 }) => {
        const created = await call("/items", post({ type: "task", title: "made by erin", project: "alpha" }));
        expect(created.status, created.text).toBe(201);
        expect((await call("/items", post({ type: "task", title: "no project" }))).status).toBe(400);
        const outside = await call("/items", post({ type: "task", title: "into beta", project: "beta" }));
        const nowhere = await call("/items", post({ type: "task", title: "into nothing", project: "no-such-project" }));
        expect(outside.status).toBe(404);
        expect(nowhere.status).toBe(404);
        expect(outside.body.error.message.replace("beta", "?")).toBe(nowhere.body.error.message.replace("no-such-project", "?"));

        const writes: Array<[string, unknown]> = [
          ["notes", { text: "a note" }],
          ["tags", { add: ["x"] }],
          ["rank", { rank: 1 }],
          ["edit", { title: "renamed" }],
          ["close", { note: "done" }],
          ["reopen", {}],
        ];
        for (const [action, body] of writes) {
          const ok = await call(`/items/${a1}/${action}`, post(body));
          expect(ok.status, `${action}: ${ok.text}`).toBeLessThan(300);
          const hidden = await call(`/items/${b1}/${action}`, post(body));
          const missing = await call(`/items/no-such-item/${action}`, post(body));
          expect(hidden.status, action).toBe(404);
          expect(hidden.body.error.message.replace(b1, "?")).toBe(missing.body.error.message.replace("no-such-item", "?"));
        }
        expect((await call(`/items/${a1}/links`, post({ rel: "references", to: a2 }))).status).toBeLessThan(300);
        expect((await call(`/items/${a1}/links`, post({ rel: "references", to: b1 }))).status).toBe(404);
        expect((await call(`/items/${a1}/edit`, post({ project: "beta" }))).status).toBe(404);
        expect((await call(`/items/${a1}/edit`, post({ project: "" }))).status).toBe(400);
        expect((await call(`/items/${a1}`, { method: "DELETE" })).status).toBe(403);

        // The beta item is untouched.
        const beta = await getItem(store, b1);
        expect(beta?.status).not.toBe("done");
        expect(beta?.title).toBe("beta secret");
      });
    },
    BUDGET,
  );

  test(
    "a decision written through a scoped token is erin's, whatever actor the body names",
    async () => {
      await withScopedApi(async ({ store, call, a1 }) => {
        const res = await call(`/items/${a1}/close`, post({ note: "shipped", actor: "mallory" }));
        expect(res.status, res.text).toBe(200);
        const id = (await getItem(store, a1))!.id;
        const [latest] = await decisionsForItem(store, id);
        expect(latest?.who).toBe("erin");
        // The admin token still writes as the body says.
        await call(`/items/${a1}/reopen`, { ...post({ actor: "mallory" }), token: ADMIN });
        expect((await decisionsForItem(store, id))[0]?.who).toBe("mallory");
      });
    },
    BUDGET,
  );
});

describe("spinoffs through a scoped token (OS-179)", () => {
  test(
    "an allowed ticket is enqueued, checked, claimed, stamped, readied and landed; the list is filtered; a disallowed row is 404",
    async () => {
      await withScopedApi(async ({ store, call, a1, b1 }) => {
        // A beta row the admin queued.
        const beta = await enqueueSpinoff(store, { ticketRef: b1, repo: "beta", branch: "b1", mode: "agent", brief: "beta work" });

        const check = await call("/spinoffs/check", post({ ticket_ref: a1, architect: {}, checker: {}, resolutions: [] }));
        expect(check.status, check.text).not.toBe(403);
        expect(check.status).not.toBe(404);
        expect((await call("/spinoffs/check", post({ ticket_ref: b1, architect: {}, checker: {}, resolutions: [] }))).status).toBe(404);

        const enq = await call("/spinoffs", post({ ticket_ref: a1, repo: "alpha", branch: "a1", mode: "agent", brief: "alpha work", no_check: "test", actor: "mallory" }));
        expect(enq.status, enq.text).toBe(201);
        const id = enq.body.row.id as number;
        expect((await call("/spinoffs", post({ ticket_ref: b1, repo: "beta", branch: "b1x", mode: "agent", brief: "x", no_check: "test" }))).status).toBe(404);

        const list = await call("/spinoffs");
        expect(list.body.spinoffs.map((r: any) => r.id)).toEqual([id]);
        expect((await call("/spinoffs", { token: ADMIN })).body.spinoffs.map((r: any) => r.id).sort()).toEqual([beta.row.id, id].sort());

        const launchable = await call("/spinoffs/launchable", post({}));
        expect(launchable.status, launchable.text).toBe(200);
        expect(launchable.body.rows.map((r: any) => r.row.id)).toEqual([id]);

        // A beta row is the same 404 as a row that does not exist, on every row op.
        for (const op of ["claim", "stamp", "land", "ready", "sendback", "verdict", "note-error", "tokens"]) {
          const body = { id: beta.row.id, outcome: "launched", verdict: "pass", tokens: { input: 1 } };
          const hidden = await call(`/spinoffs/${op}`, post(body));
          const missing = await call(`/spinoffs/${op}`, post({ ...body, id: 999999 }));
          expect(hidden.status, op).toBe(404);
          expect(hidden.body.error.message.replace(String(beta.row.id), "?")).toBe(missing.body.error.message.replace("999999", "?"));
        }
        for (const op of ["reclaim", "reopen", "trial"]) expect((await call(`/spinoffs/${op}`, post({ id }))).status, op).toBe(403);

        const claim = await call("/spinoffs/claim", post({ id, holder: "someone-else" }));
        expect(claim.status, claim.text).toBe(200);
        expect(claim.body.claimed).toBeTruthy();
        const stamp = await call("/spinoffs/stamp", post({ id, outcome: "launched", worktree: "/nowhere/alpha.a1" }));
        expect(stamp.status, stamp.text).toBe(200);
        const ready = await call("/spinoffs/ready", post({ id, note: "done" }));
        expect(ready.status, ready.text).toBe(200);
        const land = await call("/spinoffs/land", post({ id }));
        expect(land.status, land.text).toBe(200);
        expect(land.body.landed).toBe(true);

        // The beta row is where the admin left it.
        const after = (await call("/spinoffs", { token: ADMIN })).body.spinoffs.find((r: any) => r.id === beta.row.id);
        expect(after.status).toBe("pending");
      });
    },
    BUDGET,
  );

  test(
    "the claim filters inside its one UPDATE: a beta row is not claimed even past the guard",
    async () => {
      const { claimSpinoffRow } = await import("../../../platform/cli-coord/src/commands/spinoff.ts");
      await withScopedApi(async ({ store, b1 }) => {
        const beta = await enqueueSpinoff(store, { ticketRef: b1, repo: "beta", branch: "b1", mode: "agent", brief: "beta work" });
        const alphaId = (await store.q.select().from(store.t.project)).find((p) => p.name === "alpha")!.id;
        expect((await claimSpinoffRow(store, beta.row.id, "", { projectIds: [alphaId] })).claimed).toBeFalsy();
        expect((await claimSpinoffRow(store, beta.row.id, "", { projectIds: [] })).claimed).toBeFalsy();
        expect((await claimSpinoffRow(store, beta.row.id, "")).claimed).toBeTruthy();
      });
    },
    BUDGET,
  );

  test(
    "/spinoffs/config keeps only in-scope projects' repos",
    async () => {
      await withScopedApi(async ({ store, call }) => {
        await setConfig(store, "repo_checkouts", JSON.stringify({ alpha: "/src/alpha", beta: "/src/beta" }));
        await setConfig(store, "spinoff_launcher_by_repo", JSON.stringify({ alpha: "t3", beta: "t3" }));
        const admin = await call("/spinoffs/config", { token: ADMIN });
        expect(Object.keys(admin.body.config.repo_checkouts).sort()).toEqual(["alpha", "beta"]);
        const scoped = await call("/spinoffs/config");
        expect(scoped.status, scoped.text).toBe(200);
        expect(scoped.body.config.repo_checkouts).toEqual({ alpha: "/src/alpha" });
        expect(scoped.body.config.launcher_by_repo).toEqual({ alpha: "t3" });
      });
    },
    BUDGET,
  );
});

describe("agents, leases, teams and inbox through a scoped token (OS-179)", () => {
  test(
    "agents: listed and written by ticket; a beta agent is hidden and 404; reset is 403",
    async () => {
      await withScopedApi(async ({ store, call, a1, b1 }) => {
        await registerAgent(store, { id: "b1-builder", ticket: b1, ttlS: 600 });
        await registerAgent(store, { id: "loose", ttlS: 600 });
        const reg = await call("/agents", post({ action: "register", id: "a1-builder", ticket: a1, status: "working" }));
        expect(reg.status, reg.text).toBe(200);
        expect((await call("/agents")).body.agents.map((a: any) => a.id)).toEqual(["a1-builder"]);
        expect((await call("/agents/active")).body.count).toBe(1);
        expect((await call("/agents/active", { token: ADMIN })).body.count).toBe(3);

        const hidden = await call("/agents", post({ action: "heartbeat", id: "b1-builder" }));
        expect(hidden.status).toBe(404);
        expect((await call("/agents", post({ action: "register", id: "new-b", ticket: b1 }))).status).toBe(404);
        expect((await call("/agents", post({ action: "register", id: "no-ticket" }))).status).toBe(404);
        expect((await call("/agents", post({ action: "heartbeat", id: "a1-builder" }))).status).toBe(200);
        expect((await call("/agents/reset", post({}))).status).toBe(403);
      });
    },
    BUDGET,
  );

  test(
    "leases: listed by what they name; a write naming a beta ticket or a machine slot is 404; holder is erin; sweep is 403",
    async () => {
      await withScopedApi(async ({ store, call, a1, b1 }) => {
        await acquireLease(store, `ticket:${b1}`, "someone", 600);
        await acquireLease(store, "cpu:browser", "someone", 600);
        const take = await call("/leases", post({ resource: `ticket:${a1}`, holder: "mallory", ttl_s: 600 }));
        expect(take.status, take.text).toBe(200);
        const listed = (await call("/leases")).body.leases;
        expect(listed.map((l: any) => l.resource)).toEqual([`ticket:${a1}`]);
        expect(listed[0].holder).toBe("erin");

        expect((await call("/leases", post({ resource: `ticket:${b1}`, holder: "erin", ttl_s: 600 }))).status).toBe(404);
        expect((await call("/leases", post({ resource: "cpu:browser", holder: "erin", ttl_s: 600 }))).status).toBe(404);
        expect((await call(`/leases/${encodeURIComponent(`ticket:${b1}`)}?holder=someone&force=true`, { method: "DELETE" })).status).toBe(404);
        // Release names erin as the holder whatever the query says, so another holder's lease cannot be forced.
        const rel = await call(`/leases/${encodeURIComponent(`ticket:${a1}`)}?holder=mallory&force=true`, { method: "DELETE" });
        expect(rel.status, rel.text).toBe(200);
        expect((await call("/leases")).body.leases).toEqual([]);
        expect((await call("/leases/sweep", post({}))).status).toBe(403);
      });
    },
    BUDGET,
  );

  test(
    "teams: in scope only when all their projects are; out-of-scope teams are hidden and 404; inbox works as erin",
    async () => {
      await withScopedApi(async ({ store, call }) => {
        await addTeam(store, { name: "red", projects: ["alpha"] });
        await addTeam(store, { name: "blue", projects: ["beta"] });
        await addTeam(store, { name: "mixed" });
        await registerProject(store, { name: "gamma", kind: "side" });
        await registerProject(store, { name: "delta", kind: "side" });
        await addTeam(store, { name: "purple", projects: ["gamma", "delta"] });
        // erin's scope is alpha only.
        expect((await call("/teams")).body.teams.map((t: any) => t.name)).toEqual(["red"]);
        expect((await call("/teams/red")).status).toBe(200);
        const hidden = await call("/teams/blue");
        const missing = await call("/teams/nope");
        expect(hidden.status).toBe(404);
        expect(hidden.body.error.message.replace("blue", "?")).toBe(missing.body.error.message.replace("nope", "?"));
        expect((await call("/teams/mixed")).status).toBe(404);

        const sent = await call("/teams/red/inbox", post({ role: "architect", from: "mallory", body: "hello" }));
        expect(sent.status, sent.text).toBeLessThan(300);
        expect(sent.body.message.from_actor).toBe("erin");
        const inbox = await call("/teams/red/inbox?role=architect");
        expect(inbox.status, inbox.text).toBe(200);
        expect(inbox.body.messages.length).toBe(1);
        expect((await call("/teams/blue/inbox", post({ role: "architect", from: "erin", body: "x" }))).status).toBe(404);
        expect((await call("/teams/blue/inbox?role=architect")).status).toBe(404);

        for (const [m, p] of [
          ["POST", "/teams"],
          ["POST", "/teams/red/edit"],
          ["POST", "/teams/red/join"],
          ["POST", "/teams/leave"],
          ["DELETE", "/teams/red"],
        ] as const) {
          expect((await call(p, { method: m, ...(m === "POST" ? { body: {} } : {}) })).status, `${m} ${p}`).toBe(403);
        }

        // The role agent of an in-scope team is in scope, another team's is not.
        await registerAgent(store, { id: "architect-red", ttlS: 600 });
        await registerAgent(store, { id: "architect-blue", ttlS: 600 });
        expect((await call("/agents")).body.agents.map((a: any) => a.id)).toEqual(["architect-red"]);
      });
    },
    BUDGET,
  );

  test(
    "decisions: the list and show are filtered by the decision's project; supersede is 403",
    async () => {
      await withScopedApi(async ({ store, call }) => {
        const da = await createItem(store, { type: "decision", title: "alpha decision", projectId: "alpha" });
        const db = await createItem(store, { type: "decision", title: "beta decision", projectId: "beta" });
        const list = await call("/decisions");
        expect(list.status, list.text).toBe(200);
        expect(list.body.decisions.map((d: any) => d.id)).toEqual([da]);
        const refOf = async (id: string) => (await getItem(store, id))?.ref ?? id;
        expect((await call(`/decisions/${await refOf(da)}`)).status).toBe(200);
        const hidden = await call(`/decisions/${await refOf(db)}`);
        expect(hidden.status).toBe(404);
        expect((await call("/decisions/supersede", post({ new_id: da, old_id: db }))).status).toBe(403);
      });
    },
    BUDGET,
  );
});

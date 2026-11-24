// OS-178: a scoped API token reaches only the route families and the projects its entry names.
//
// Over a REAL Postgres store (the ob 325 harness), like api-352: the filter is asserted on the rows that come
// back, not on the status code alone. The tokens file is a real file in a scratch directory, re-read per
// request, so the permission refusal and `revoke` are the real code path.
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import {
  OB_API_ADMIN_FAMILIES,
  OB_API_PREFIX,
  OB_API_ROUTES,
  OB_API_SCOPABLE_FAMILIES,
  matchApiRoute,
} from "../../../apps/cli/src/api/contract.ts";
import {
  authenticate,
  loadScopedTokens,
  readTokensForEdit,
  sha256Hex,
  writeTokens,
  type ScopedTokenEntry,
} from "../../../apps/cli/src/api/scoped-tokens.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { addLink, createItem, getItem } from "../../../apps/cli/src/items.ts";
import { cmdApiToken } from "../../../apps/cli/src/commands/api-token.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";

const ADMIN = "an-admin-bearer-token-that-is-long-enough";
const ALICE = "alice-scoped-token-0123456789abcdef0123456789";
const BUDGET = spawnBudget(4);

const scratch = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "ob-scoped-178-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let fileSeq = 0;

function tokensFile(entries: ScopedTokenEntry[], mode = 0o600): string {
  const path = join(scratch, `tokens-${++fileSeq}.json`);
  writeFileSync(path, JSON.stringify(entries));
  chmodSync(path, mode);
  return path;
}

const alice = (projects: string[] = ["alpha"], families: string[] = [...OB_API_SCOPABLE_FAMILIES]): ScopedTokenEntry => ({
  user: "alice",
  sha256: sha256Hex(ALICE),
  projects,
  families,
});

interface Fixture {
  store: Store;
  call(path: string, opts?: { method?: string; token?: string | null; body?: unknown }): Promise<{ status: number; body: any; text: string }>;
  ids: { a1: string; a2: string; b1: string; loose: string };
  /** What a client asks for an item by: its ref, or its id when it has none (a bare id collides with a ref number). */
  refs: { a1: string; b1: string; loose: string };
  setPath(p: string): void;
}

async function withScopedApi(path: string, fn: (f: Fixture) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  let tokensPath = path;
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: ADMIN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    scopedTokens: () => loadScopedTokens(tokensPath),
  });
  try {
    await registerProject(store, { name: "alpha", kind: "side" });
    await registerProject(store, { name: "beta", kind: "side" });
    const a1 = await createItem(store, { type: "task", title: "zebra alpha one", projectId: "alpha" });
    const a2 = await createItem(store, { type: "task", title: "zebra alpha two", projectId: "alpha" });
    const b1 = await createItem(store, { type: "task", title: "zebra beta secret", projectId: "beta" });
    const loose = await createItem(store, { type: "task", title: "zebra no project" });
    await addLink(store, a1, "references", a2);
    await addLink(store, a1, "references", b1);
    const call: Fixture["call"] = async (p, opts = {}) => {
      const headers: Record<string, string> = {};
      const token = opts.token === undefined ? ALICE : opts.token;
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
    const refOf = async (id: string) => (await getItem(store, id))?.ref ?? id;
    const refs = { a1: await refOf(a1), b1: await refOf(b1), loose: await refOf(loose) };
    await fn({ store, call, ids: { a1, a2, b1, loose }, refs, setPath: (p) => (tokensPath = p) });
  } finally {
    await store.close();
    await lease.release();
  }
}

/**
 * The routes that never authenticate (a phone's browser cannot send a bearer token, and GitHub signs its
 * webhook instead): the token in the header is not read on them, scoped or admin, so the family gate is not
 * theirs. They are asserted to answer a scoped token exactly as they answer no token at all.
 */
const UNAUTHENTICATED = new Set(["GET /google/auth", "GET /google/callback", "POST /github/webhook"]);

/** A concrete path for a route pattern: every `:param` becomes `x`. */
const concrete = (pattern: string) => pattern.replace(/:[^/]+/g, "x");

describe("route families are classified (OS-178)", () => {
  test("every OB_API_ROUTES family is in exactly one of the scopable and admin sets", () => {
    const scopable = new Set(OB_API_SCOPABLE_FAMILIES);
    const admin = new Set(OB_API_ADMIN_FAMILIES);
    for (const f of scopable) expect(admin.has(f), `${f} is in both sets`).toBe(false);
    const unclassified = OB_API_ROUTES.filter((r) => !scopable.has(r.family) && !admin.has(r.family)).map((r) => `${r.method} ${r.path} (${r.family})`);
    expect(unclassified).toEqual([]);
  });

  test("the matcher maps every route to itself, and a literal segment beats a parameter", () => {
    for (const r of OB_API_ROUTES) {
      const segs = r.path.split("/").filter(Boolean).map((s) => (s.startsWith(":") ? "x" : s));
      const hit = matchApiRoute(r.method, segs);
      expect(hit, `${r.method} ${r.path}`).not.toBeNull();
      expect(hit!.family, `${r.method} ${r.path}`).toBe(r.family);
    }
    expect(matchApiRoute("GET", ["no-such-family"])).toBeNull();
    expect(matchApiRoute("PATCH", ["items"])).toBeNull();
  });
});

describe("the tokens file (OS-178)", () => {
  test("absent is no scoped users and no message; a world-readable file is refused naming the path, never a hash", () => {
    const absent = loadScopedTokens(join(scratch, "absent.json"));
    expect(absent).toEqual({ entries: [], path: join(scratch, "absent.json"), message: null });

    const open = tokensFile([alice()], 0o644);
    const refused = loadScopedTokens(open);
    expect(refused.entries).toEqual([]);
    expect(refused.message).toContain(open);
    expect(refused.message).toContain("chmod 600");
    expect(refused.message).not.toContain(sha256Hex(ALICE));

    const auth = authenticate(ALICE, ADMIN, () => refused);
    expect(auth).toEqual({ ok: false, disabledMessage: refused.message });
    // The admin token is never affected by a broken tokens file.
    expect(authenticate(ADMIN, ADMIN, () => refused)).toEqual({ ok: true, principal: { user: "admin", all: true } });
  });

  test("a malformed file is refused naming the entry, not its hash", () => {
    const path = join(scratch, "bad.json");
    writeFileSync(path, JSON.stringify([{ user: "bob", sha256: "not-hex", projects: [], families: [] }]));
    chmodSync(path, 0o600);
    const load = loadScopedTokens(path);
    expect(load.message).toContain(path);
    expect(load.message).toContain("entry 0");
    expect(load.message).not.toContain("not-hex");
  });

  test("authenticate matches by hash and returns the scoped principal; an unknown token is a plain refusal", () => {
    const load = loadScopedTokens(tokensFile([alice()]));
    expect(authenticate(ALICE, ADMIN, () => load)).toEqual({
      ok: true,
      principal: { user: "alice", all: false, projects: ["alpha"], families: [...OB_API_SCOPABLE_FAMILIES] },
    });
    expect(authenticate("nope", ADMIN, () => load)).toEqual({ ok: false, disabledMessage: null });
    expect(authenticate(null, ADMIN, () => load)).toEqual({ ok: false, disabledMessage: null });
  });
});

describe("ob api-token (OS-178)", () => {
  test("add prints the token once and stores only its hash, list never prints a hash, revoke removes it", async () => {
    const path = join(scratch, "cli-tokens.json");
    const prev = process.env.OB_API_TOKENS_FILE;
    process.env.OB_API_TOKENS_FILE = path;
    const out: string[] = [];
    const log = console.log;
    const write = process.stdout.write.bind(process.stdout);
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    const run = (args: string[], flags: Record<string, unknown> = {}) => cmdApiToken({ args, flags } as never);
    try {
      await run(["add", "carol"], { project: "alpha, beta" });
      const token = out.join("").trim();
      expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
      const entries = readTokensForEdit(path);
      expect(entries).toEqual([{ user: "carol", sha256: sha256Hex(token), projects: ["alpha", "beta"], families: [...OB_API_SCOPABLE_FAMILIES] }]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).not.toContain(token);

      await expect(run(["add", "carol"], { project: "alpha" })).rejects.toThrow("already has a token");
      await expect(run(["add", "dave"])).rejects.toThrow("--project is required");

      out.length = 0;
      await run(["list"]);
      await run(["list"], { json: true });
      const listed = out.join("\n");
      expect(listed).toContain("carol");
      expect(listed).toContain("alpha");
      expect(listed).not.toContain(entries[0]!.sha256);
      expect(listed).not.toContain(token);

      await run(["revoke", "carol"]);
      expect(readTokensForEdit(path)).toEqual([]);
      await expect(run(["revoke", "carol"])).rejects.toThrow("no scoped API token for 'carol'");
    } finally {
      console.log = log;
      process.stdout.write = write;
      if (prev === undefined) delete process.env.OB_API_TOKENS_FILE;
      else process.env.OB_API_TOKENS_FILE = prev;
    }
  });

  test("a world-readable file is refused for editing, naming the path", () => {
    const path = tokensFile([alice()], 0o640);
    expect(() => readTokensForEdit(path)).toThrow(path);
    // Rewriting it is the fix: the file comes back 0600 and loads.
    writeTokens([alice()], path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readTokensForEdit(path)).toEqual([alice()]);
  });
});

describe("a scoped token over the API (OS-178)", () => {
  test(
    "every route-family pair: a marked route on a granted family passes the gate, everything else is 403 forbidden",
    async () => {
      await withScopedApi(tokensFile([alice()]), async ({ call }) => {
        for (const r of OB_API_ROUTES) {
          if (UNAUTHENTICATED.has(`${r.method} ${r.path}`)) {
            const opts = { method: r.method, ...(r.method === "POST" ? { body: {} } : {}) };
            expect((await call(concrete(r.path), opts)).status, `${r.method} ${r.path}`).toBe((await call(concrete(r.path), { ...opts, token: null })).status);
            continue;
          }
          const res = await call(concrete(r.path), { method: r.method, ...(r.method === "POST" ? { body: {} } : {}) });
          // OS-179: a route opens only when marked `scoped`, and a non-GET only when marked `write`.
          const granted = r.scoped !== undefined && OB_API_SCOPABLE_FAMILIES.includes(r.family) && (r.method === "GET" || r.scoped === "write");
          if (granted) expect(res.status, `${r.method} ${r.path}`).not.toBe(403);
          else {
            expect(res.status, `${r.method} ${r.path}`).toBe(403);
            expect(res.body.error.code).toBe("forbidden");
          }
          expect(res.text).not.toContain(ALICE);
          expect(res.text).not.toContain(sha256Hex(ALICE));
        }
        // Named in the ticket, and an unmapped path and a PATCH fail safe.
        for (const p of ["/secrets", "/gmail/search", "/whatsapp/recent", "/status", "/snapshot", "/no-such-family", "/items/x/y/z"]) {
          expect((await call(p)).status, p).toBe(403);
        }
        for (const m of ["PATCH", "DELETE"]) expect((await call("/items", { method: m, body: {} })).status, m).toBe(403);
        expect((await call("/items/x", { method: "DELETE" })).status).toBe(403);
      });
    },
    BUDGET,
  );

  test(
    "lists, next, search, projects and item detail come back filtered to its projects",
    async () => {
      await withScopedApi(tokensFile([alice()]), async ({ store, call, ids, refs }) => {
        const items = await call("/items?state=all");
        expect(items.status).toBe(200);
        expect(items.body.items.map((i: any) => i.id).sort()).toEqual([ids.a1, ids.a2].sort());

        expect((await call("/items?project=alpha")).body.items.length).toBe(2);
        const next = await call("/next");
        expect(next.status).toBe(200);
        expect(next.body.items.every((i: any) => i.project === "alpha")).toBe(true);
        expect(typeof next.body.triage_count).toBe("number");

        const search = await call("/search?q=zebra");
        expect(search.status).toBe(200);
        expect(search.body.items.map((i: any) => i.id).sort()).toEqual([ids.a1, ids.a2].sort());

        const projects = await call("/projects");
        expect(projects.body.projects.map((p: any) => p.name)).toEqual(["alpha"]);

        const detail = await call(`/items/${refs.a1}`);
        expect(detail.status, detail.text).toBe(200);
        expect(detail.body.item.links.map((l: any) => l.other)).toEqual([ids.a2]);
        expect(detail.text).not.toContain("zebra beta secret");

        // The focus project is a project id: beta's is not the scoped token's to see, alpha's is.
        await setConfig(store, "focus_project", "beta");
        for (const p of ["/next", "/items", "/search?q=zebra"]) expect((await call(p)).body.focus_project, p).toBeNull();
        await setConfig(store, "focus_project", "alpha");
        expect((await call("/next")).body.focus_project).toBe("alpha");

        // The admin still sees everything.
        const all = await call("/items?state=all", { token: ADMIN });
        expect(all.body.items.map((i: any) => i.id)).toContain(ids.b1);
        // The admin sees both readings of a bare number that collides with an OB-<n>, and is refused as
        // before; the scoped token cannot see the OB-<n> item, so for it the number is just the id.
        expect(refs.a1).toBe(ids.a1); // alpha has no key, so the bare id is a1's only handle
        expect(refs.loose).toBe(`OB-${ids.a1}`);
        expect((await call(`/items/${refs.a1}`, { token: ADMIN })).status).toBe(400);
      });
    },
    BUDGET,
  );

  test(
    "an item or project outside its scope is 404, the same as one that does not exist",
    async () => {
      await withScopedApi(tokensFile([alice()]), async ({ call, refs }) => {
        const hidden = await call(`/items/${refs.b1}`);
        const missing = await call("/items/no-such-item-at-all");
        expect(hidden.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(hidden.body.error.code).toBe(missing.body.error.code);
        expect((await call(`/items/${refs.loose}`)).status).toBe(404);
        // OS-179: a team outside the scope reads like an unknown one.
        expect((await call("/items?team=anything")).status).toBe(404);
        for (const p of ["/items?project=beta", "/next?project=beta", "/items?project=nope", "/next?project=nope"]) {
          expect((await call(p)).status, p).toBe(404);
        }
      });
    },
    BUDGET,
  );

  test(
    "a bare number is the item the token can see; only when it sees both readings is it refused, naming neither",
    async () => {
      // loose holds OB-<a1's id>. Scoped to alpha, the bare id is a1 (loose is out of scope).
      await withScopedApi(tokensFile([alice(["alpha"])]), async ({ store, call, ids, refs, setPath }) => {
        expect(refs.loose).toBe(`OB-${ids.a1}`);
        expect((await call(`/items/${ids.a1}`)).body.item.id).toBe(ids.a1);
        // Move loose into beta (it keeps OB-<n>): scoped to beta, the bare number is loose, not out-of-scope a1.
        await store.q.update(store.t.item).set({ project_id: "beta" }).where(eq(store.t.item.id, ids.loose));
        setPath(tokensFile([alice(["beta"])]));
        expect((await call(`/items/${ids.a1}`)).body.item.id).toBe(ids.loose);
        // Both visible: refused, and the message names neither item.
        setPath(tokensFile([alice(["alpha", "beta"])]));
        const both = await call(`/items/${ids.a1}`);
        expect(both.status).toBe(400);
        expect(both.text).not.toContain(refs.loose);
        expect(both.text).not.toContain("zebra");
      });
    },
    BUDGET,
  );

  test(
    "a family not in its entry is 403, the file is re-read per request, and a world-readable file is a 503 naming the path",
    async () => {
      await withScopedApi(tokensFile([alice(["alpha"], ["items"])]), async ({ call, setPath }) => {
        expect((await call("/items")).status).toBe(200);
        expect((await call("/next")).status).toBe(403);

        // Revoked: the next request is a plain 401, no restart.
        setPath(tokensFile([]));
        expect((await call("/items")).status).toBe(401);

        const open = tokensFile([alice()], 0o644);
        setPath(open);
        const res = await call("/items");
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe("api_disabled");
        expect(res.body.error.message).toContain(open);
        expect(res.text).not.toContain(sha256Hex(ALICE));
        expect(res.text).not.toContain(ALICE);
        // The admin is untouched by the broken file.
        expect((await call("/items", { token: ADMIN })).status).toBe(200);
      });
    },
    BUDGET,
  );

  test(
    "with no tokens file the admin token behaves as before and any other token is 401",
    async () => {
      await withScopedApi(join(scratch, "never-written.json"), async ({ call, refs }) => {
        expect((await call("/items?state=all", { token: ADMIN })).body.items.length).toBe(4);
        expect((await call(`/items/${refs.b1}`, { token: ADMIN })).status).toBe(200);
        expect((await call("/status", { token: ADMIN })).status).not.toBe(403);
        expect((await call("/items")).status).toBe(401);
      });
    },
    BUDGET,
  );
});

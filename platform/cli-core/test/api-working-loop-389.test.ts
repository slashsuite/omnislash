// ob 389 — spinoff working-loop holes over the API: link, add --issue, issue landed/drift/reconcile.
//
// CLIENT half: stubbed transport, no network, no token file, no database (api-client-353's seam).
// SERVER half: real Postgres via the 325 harness; GitHub client stubbed (no live network).
import { afterEach, describe, expect, test } from "bun:test";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS, LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import { renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { __setCreateIssue, type CreatedIssue } from "../../../apps/cli/src/github-issues.ts";
import { __setListIssues } from "../../../apps/cli/src/tracker-link.ts";
import { __setSh, type Sh } from "../../../apps/cli/src/tracker-link.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const README = cliDocs();
const REPO = "owner/acme";
const REC = "\x1e";
const FLD = "\x1f";

interface Stub {
  transport: ApiTransport;
  calls: ApiRequest[];
}

function stub(answers: Record<string, unknown>): Stub {
  const calls: ApiRequest[] = [];
  const transport: ApiTransport = async (req) => {
    calls.push(req);
    const path = req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!;
    const key = `${req.method} ${path}`;
    if (!(key in answers)) {
      return {
        status: 404,
        body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }),
      };
    }
    return { status: 200, body: JSON.stringify(answers[key]) };
  };
  return { transport, calls };
}

function api(s: Stub) {
  return { api: { base: BASE, token: TOKEN, transport: s.transport } };
}

function pairing(over: Record<string, unknown> = {}) {
  return {
    tracker_repo: REPO,
    issues: [{ id: "389", status: "open", title: "working loop", issue: 200, repo: REPO }],
    unlinked_ob_ids: [],
    spinoffs: [],
    item_ids: ["389"],
    ...over,
  };
}

function fakeGit(opts: { log?: Array<{ sha: string; subject: string; body?: string }>; failing?: boolean } = {}): Sh {
  return (cmd) => {
    const joined = cmd.join(" ");
    if (opts.failing) return { ok: false, err: "not a git repository", out: "" };
    if (joined.includes("rev-parse --show-toplevel")) return { ok: true, err: "", out: "/repo\n" };
    if (joined.includes("config --get remote.origin.url")) {
      return { ok: true, err: "", out: `git@github.com:${REPO}.git\n` };
    }
    if (cmd.includes("log")) {
      return {
        ok: true,
        err: "",
        out: (opts.log ?? []).map((c) => `${c.sha}${FLD}${c.subject}${FLD}${c.body ?? ""}${REC}`).join("\n"),
      };
    }
    if (joined.includes("rev-list --first-parent")) return { ok: true, err: "", out: "" };
    if (joined.includes("rev-list --count")) return { ok: true, err: "", out: "0" };
    if (cmd.includes("branch")) return { ok: true, err: "", out: "" };
    return { ok: false, err: `unstubbed git call: ${joined}`, out: "" };
  };
}

describe("routing (389)", () => {
  test("link/edit/rm/today/focus are ROUTED and have handlers", () => {
    for (const cmd of ["link", "edit", "rm", "today", "focus"]) {
      expect(API_ROUTED_COMMANDS.has(cmd)).toBe(true);
      expect(LOCAL_ONLY_COMMANDS.has(cmd)).toBe(false);
      expect(typeof API_HANDLERS[cmd]).toBe("function");
    }
  });

  test("API_HANDLERS keys still match API_ROUTED_COMMANDS", () => {
    expect(Object.keys(API_HANDLERS).sort()).toEqual([...API_ROUTED_COMMANDS].sort());
  });
});

describe("docs/HELP (389)", () => {
  test("HELP and README say landed runs git HERE, not on the API host", () => {
    const help = renderSubcommandHelp("issue", "landed");
    expect(help).toContain("issue landed");
    expect(help).toContain("never on the API host");
    expect(README).toContain("do **not** print \"run it on the API host\"");
    expect(README).toContain("ob add --issue");
  });
});

describe("API client: link / add --issue / add --link (389)", () => {
  test("`ob link` posts the rel and does not print 'run it on the API host'", async () => {
    const s = stub({ "POST /items/10/links": { id: "10" } });
    const r = await runCli(freshDbPath(), ["link", "10", "blocks", "11"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("10");
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ rel: "blocks", to: "11" });
    expect(r.err).not.toContain("run it on the API host");
  });

  test("`ob add --issue` posts issue:true and prints the pair", async () => {
    const s = stub({
      "POST /items": {
        id: "99",
        item: { id: "99", title: "ship it" },
        issue: { number: 42, url: "https://github.com/owner/acme/issues/42" },
      },
    });
    const r = await runCli(freshDbPath(), ["add", "ship it", "--issue", "--project", "acme"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("99  → issue #42");
    expect(JSON.parse(s.calls[0]!.body!).issue).toBe(true);
    expect(r.err).not.toContain("run it on the API host");
  });

  test("`ob add --link` posts link_url and does not refuse", async () => {
    const s = stub({ "POST /items": { id: "7", item: { id: "7", title: "x" } } });
    const r = await runCli(freshDbPath(), ["add", "x", "--link", "https://example.test/a", "--project", "acme"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(s.calls[0]!.body!).link_url).toBe("https://example.test/a");
    expect(r.err).not.toContain("run it on the API host");
  });
});

describe("API client: issue landed / drift / reconcile (389)", () => {
  let restoreSh: (() => void) | undefined;
  afterEach(() => {
    restoreSh?.();
    restoreSh = undefined;
  });

  test("`ob issue landed` answers from THIS git, pairing from the API; never 'API host'", async () => {
    restoreSh = __setSh(
      fakeGit({ log: [{ sha: "abc1234deadbee", subject: "Merge ob 389" }] }),
    );
    const s = stub({ "GET /issues/pairing": pairing() });
    const r = await runCli(freshDbPath(), ["issue", "landed", "389"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("ALREADY ON MAIN");
    expect(s.calls.map((c) => `${c.method} ${c.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]}`)).toEqual([
      "GET /issues/pairing",
      "GET /items/OB-389", // OB-1700: does the ticket shown as OB-389 name another item?
    ]);
    expect(r.err).not.toContain("run it on the API host");
    expect(r.out).not.toContain("a bare number is the internal item id");
  });

  test("`ob issue landed <n>` says when OB-<n> is a different item (OB-1700)", async () => {
    restoreSh = __setSh(fakeGit({ log: [{ sha: "abc1234deadbee", subject: "Merge ob 389" }] }));
    const s = stub({ "GET /issues/pairing": pairing(), "GET /items/OB-389": { item: { id: "2302", ref: "OB-389", title: "other" } } });
    const r = await runCli(freshDbPath(), ["issue", "landed", "389"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("a bare number is the internal item id");
    expect(r.out).toContain("ob issue landed OB-389");
  });

  test("`ob issue landed -q` prints landed / not-landed / could-not-tell from THIS git", async () => {
    restoreSh = __setSh(fakeGit({ log: [] }));
    const s = stub({ "GET /issues/pairing": pairing() });
    const r = await runCli(freshDbPath(), ["issue", "landed", "389", "-q"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("not-landed");
    expect(r.err).not.toContain("run it on the API host");
  });

  test("`ob issue landed` with no checkout here names THIS machine, not the API host", async () => {
    restoreSh = __setSh(fakeGit({ failing: true }));
    const s = stub({ "GET /issues/pairing": pairing() });
    const r = await runCli(freshDbPath(), ["issue", "landed", "389"], api(s));
    expect(r.code).toBe(1);
    expect(r.err).toContain("not inside a git checkout");
    expect(r.err).not.toContain("run it on the API host");
  });

  test("`ob issue drift` fetches pairing + github, runs git HERE", async () => {
    restoreSh = __setSh(fakeGit({ log: [{ sha: "abc1234deadbee", subject: "Merge #200" }] }));
    const s = stub({
      "GET /issues/pairing": pairing(),
      "GET /issues/github": { repo: REPO, issues: [{ number: 200, title: "working loop", state: "OPEN" }] },
    });
    const r = await runCli(freshDbPath(), ["issue", "drift"], api(s));
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("run it on the API host");
    expect(s.calls.map((c) => c.url.slice((BASE + OB_API_PREFIX).length).split("?")[0] ?? "").sort()).toEqual([
      "/issues/github",
      "/issues/pairing",
    ]);
  });

  test("`ob issue reconcile` does not print 'run it on the API host'", async () => {
    const s = stub({
      "GET /issues/reconcile": {
        repo: REPO,
        candidates: [
          {
            item_id: "55",
            item_title: "the thing",
            item_status: "open",
            issue: 110,
            issue_title: "the thing",
            issue_state: "open",
            score: 1,
            reasons: ["title 1.00"],
          },
        ],
      },
    });
    const r = await runCli(freshDbPath(), ["issue", "reconcile"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("ob 55");
    expect(r.out).toContain("#110");
    expect(r.err).not.toContain("run it on the API host");
  });
});

describe("API client: cheap extras (389)", () => {
  test("`ob edit` / `ob rm` / `ob today` / `ob focus` hit their endpoints", async () => {
    const s = stub({
      "POST /items/8/edit": { id: "8" },
      "DELETE /items/8": { id: "8" },
      "POST /today": { id: "8" },
      "GET /focus": { focus_project: "acme" },
    });
    expect((await runCli(freshDbPath(), ["edit", "8", "--title", "n"], api(s))).code).toBe(0);
    expect((await runCli(freshDbPath(), ["rm", "8"], api(s))).code).toBe(0);
    expect((await runCli(freshDbPath(), ["today", "8"], api(s))).code).toBe(0);
    const focus = await runCli(freshDbPath(), ["focus"], api(s));
    expect(focus.code).toBe(0);
    expect(focus.out.trim()).toBe("acme");
  });
});

// --- server half --------------------------------------------------------------------------------------

const TOKEN_S = "a-test-bearer-token-that-is-long-enough";

function url(path: string): string {
  return `http://api-host.local${OB_API_PREFIX}${path}`;
}

interface ServerCtx {
  store: Store;
  call: (path: string, opts?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any }>;
}

async function withApi(fn: (ctx: ServerCtx) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({
    kind: "postgres",
    connection: lease.options as unknown as Record<string, unknown>,
  });
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN_S, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const call = async (path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> => {
    const res = await api(
      new Request(url(path), {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers: {
          authorization: `Bearer ${TOKEN_S}`,
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        },
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

describe("POST /items --issue (389, stubbed GitHub)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("creates the GitHub issue and pairs it; no live network", async () => {
    restore = __setCreateIssue(async (_db, input): Promise<CreatedIssue> => {
      expect(input.repo).toBe(REPO);
      expect(input.title).toBe("wire the loop");
      expect(input.labels).toEqual(["wayfinder:task"]);
      return { number: 42, url: `https://github.com/${REPO}/issues/42` };
    });
    await withApi(async ({ call }) => {
      const created = await call("/items", { body: { type: "task", title: "wire the loop", issue: true } });
      expect(created.status).toBe(201);
      expect(created.body.issue).toEqual({ number: 42, url: `https://github.com/${REPO}/issues/42` });
      const pairs = await call("/issues");
      expect(pairs.body.issues).toEqual([
        expect.objectContaining({ id: created.body.id, issue: 42, repo: REPO }),
      ]);
    });
  });
});

describe("POST /items/:id/links (389)", () => {
  test("writes the rel and both items must exist", async () => {
    await withApi(async ({ store, call }) => {
      const a = await createItem(store, { type: "task", title: "from" });
      const b = await createItem(store, { type: "task", title: "to" });
      const ok = await call(`/items/${a}/links`, { body: { rel: "blocks", to: b } });
      expect(ok.status).toBe(200);
      expect(ok.body.id).toBe(a);
      const miss = await call(`/items/${a}/links`, { body: { rel: "blocks", to: "9999" } });
      expect(miss.status).toBe(404);
      const bad = await call(`/items/${a}/links`, { body: { rel: "cousin", to: b } });
      expect(bad.status).toBe(400);
    });
  });
});

describe("GET /issues/pairing + reconcile (389)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("pairing returns tracker repo, item ids, empty spinoffs", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "one" });
      const res = await call("/issues/pairing");
      expect(res.status).toBe(200);
      expect(res.body.tracker_repo).toBe(REPO);
      expect(res.body.item_ids).toContain(id);
      expect(res.body.spinoffs).toEqual([]);
    });
  });

  test("reconcile uses the injected GitHub list", async () => {
    restore = __setListIssues(async () => [
      { number: 110, title: "the frobnicator", state: "OPEN", assignees: [], labels: [], body: null, url: "" },
    ]);
    await withApi(async ({ store, call }) => {
      await createItem(store, { type: "task", title: "the frobnicator" });
      const res = await call("/issues/reconcile");
      expect(res.status).toBe(200);
      expect(res.body.repo).toBe(REPO);
      expect(res.body.candidates.length).toBeGreaterThan(0);
      expect(res.body.candidates[0]!.issue).toBe(110);
    });
  });
});

describe("cheap extras over the API (389)", () => {
  test("edit / rm / today / focus write through and read back", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "old" });
      const edited = await call(`/items/${id}/edit`, { body: { title: "new" } });
      expect(edited.status).toBe(200);
      const shown = await call(`/items/${id}`);
      expect(shown.body.item.title).toBe("new");
      const ranked = await call("/today", { body: { id } });
      expect(ranked.status).toBe(200);
      const focus = await call("/focus");
      expect(focus.status).toBe(200);
      const gone = await call(`/items/${id}`, { method: "DELETE" });
      expect(gone.status).toBe(200);
      const miss = await call(`/items/${id}`);
      expect(miss.status).toBe(404);
    });
  });
});

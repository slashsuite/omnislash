// OS-47: before a parallel dispatch, the ticket's declared files (its go check's sheets, directories and globs kept)
// are compared with every live spinoff row in the same repo: that row's declared files plus what its pushed branch
// already touched. An overlap prints one line per row, records one `overlap` decision and launches anyway.
// In-process against a fresh SQLite database, a fake T3 and the `sh` seam: no network, no live store, no real git.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCleanRepoDir, fakeRepoDir, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { eventsForItemFor, parsePayload } from "../../../apps/cli/src/events.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { __setSh, listSpinoffs, type Sh } from "../src/commands/spinoff.ts";
import { declaredFilesOf } from "../src/spinoff-check.ts";
import { entryCovers, renderOverlap, sharedPaths, touchedFiles } from "../src/spinoff-overlap.ts";

const READY = "Need stated.\n\n## Drilled\n- cause read in the code\n\n## Done when\n- a test shows it";
const ALL_TWO = { problem: 2, scope: 2, done: 2, design: 2, proof: 2, unknowns: 2, size: 2 };
const side = (files: string[]) => ({ does: "Changes a thing.", files, questions: [], scores: ALL_TWO });
const sheets = (architect: string[], checker: string[] = []) => ["--architect", JSON.stringify(side(architect)), "--reviewer", JSON.stringify(side(checker))];

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/**
 * The `sh` seam: `pushed` maps a branch to the files its `origin/main...origin/<branch>` diff names; a branch
 * not in it is not on origin. Every other command succeeds with no output (worktree adds, a fetch, a merge-base).
 */
function gitSeam(pushed: Record<string, string[]>): Sh {
  return (cmd) => {
    const ref = cmd.find((a) => a.startsWith("refs/remotes/origin/"));
    if (cmd.includes("rev-parse") && ref) return { ok: ref.slice("refs/remotes/origin/".length) in pushed, err: "", out: "" };
    const range = cmd.find((a) => a.startsWith("origin/main...origin/"));
    if (cmd.includes("diff") && range) return { ok: true, err: "", out: (pushed[range.slice("origin/main...origin/".length)] ?? []).join("\n") };
    return { ok: true, err: "", out: "" };
  };
}

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function check(dbPath: string, id: string, files: string[]) {
  const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(files)]);
  expect(r.code).toBe(0);
}

async function dispatch(dbPath: string, id: string, repo: string, pushed: Record<string, string[]> = {}, extra: string[] = []) {
  const restoreSh = __setSh(gitSeam(pushed));
  const t3 = installFakeT3([repo]);
  try {
    const r = await runCli(dbPath, ["spinoff", id, "--repo", repo, "--branch", `build-${id}`, "--worktree", tempDir("os47-wt-"), "--brief", "b", ...extra]);
    return { ...r, launches: t3.launches.length };
  } finally {
    t3.restore();
    restoreSh();
  }
}

async function preview(dbPath: string, id: string, repo: string, pushed: Record<string, string[]> = {}, extra: string[] = []) {
  const restoreSh = __setSh(gitSeam(pushed));
  const t3 = installFakeT3([repo]);
  try {
    const r = await runCli(dbPath, ["spinoff", "overlap", id, "--repo", repo, ...extra]);
    return { ...r, launches: t3.launches.length };
  } finally {
    t3.restore();
    restoreSh();
  }
}

async function overlapDecisions(dbPath: string, id: string): Promise<Array<Record<string, any>>> {
  const db = openDb(dbPath);
  const events = await eventsForItemFor(db, id, 50, { source: "ob", type: "transition" });
  db.close();
  return events.map((e) => parsePayload<Record<string, any>>(e)).filter((p) => p.from === "dispatch" && p.to === "overlap");
}

/**
 * Two live rows in one repo (A declares `apps/a.ts` and `bun.lock`; B declares `platform/`), a row in another repo
 * and a landed row (both declaring `shared.ts`), and the ticket under test, not yet dispatched.
 */
async function world(pushed: Record<string, string[]> = {}) {
  const dbPath = freshDbPath();
  const repo = fakeRepoDir();
  const db = openDb(dbPath);
  const ids = {
    a: await createItem(db, { type: "task", title: "row a", body: READY }),
    b: await createItem(db, { type: "task", title: "row b", body: READY }),
    other: await createItem(db, { type: "task", title: "other repo", body: READY }),
    landed: await createItem(db, { type: "task", title: "landed", body: READY }),
    mine: await createItem(db, { type: "task", title: "mine", body: READY }),
  };
  db.close();
  await check(dbPath, ids.a, ["apps/a.ts", "bun.lock"]);
  await check(dbPath, ids.b, ["platform/"]);
  await check(dbPath, ids.other, ["shared.ts"]);
  await check(dbPath, ids.landed, ["shared.ts"]);
  for (const id of [ids.a, ids.b, ids.other, ids.landed]) expect((await dispatch(dbPath, id, repo, pushed)).code).toBe(0);
  const elsewhere = fakeCleanRepoDir("elsewhere");
  const store = openDb(dbPath);
  const rows = await listSpinoffs(store);
  const rowOf = (id: string) => rows.find((r) => r.item_id === id)!;
  store.query("UPDATE spinoff SET repo = ? WHERE id = ?").run(elsewhere, rowOf(ids.other).id);
  store.query("UPDATE spinoff SET status = 'merged' WHERE id = ?").run(rowOf(ids.landed).id);
  store.query("UPDATE spinoff SET status = 'ready-for-gate' WHERE id = ?").run(rowOf(ids.b).id); // handed off is live
  store.close();
  return { dbPath, repo, ids, rowA: rowOf(ids.a), rowB: rowOf(ids.b) };
}

describe("the match rules (OS-47), pure", () => {
  test("an exact path, a directory entry, a glob, and lockfiles on either side", () => {
    expect(entryCovers("a.ts", "a.ts")).toBe(true);
    expect(entryCovers("dir/", "dir/x/y.ts")).toBe(true);
    expect(entryCovers("dir/**", "dir/x/y.ts")).toBe(true);
    expect(entryCovers("dir/**", "dirt/y.ts")).toBe(false);
    expect(entryCovers("apps/*/src/*.ts", "apps/cli/src/cli.ts")).toBe(true);
    expect(entryCovers("apps/*.md", "apps/cli/src/cli.ts")).toBe(false);
    expect(sharedPaths(["a.ts", "b.ts"], ["c.ts"])).toEqual([]);
    expect(sharedPaths(["a.ts", "b.ts"], ["b.ts"])).toEqual(["b.ts"]);
    expect(sharedPaths(["platform/x.ts"], ["platform/**"])).toEqual(["platform/x.ts"]);
    expect(sharedPaths(["platform/cli/"], ["platform/"])).toEqual(["platform/cli/"]);
    expect(sharedPaths(["bun.lock", "apps/cli/package-lock.json"], ["bun.lock", "apps/cli/package-lock.json", "pnpm-lock.yaml"])).toEqual([]);
  });

  test("the declared reader keeps directory and glob entries; plannedFiles still drops them", () => {
    expect(declaredFilesOf({ planner: { files: ["./a.ts:12", "apps/"] }, checker: { files: ["`b.ts`", "a.ts", "*.md"] } })).toEqual(["*.md", "a.ts", "apps/", "b.ts"]);
  });

  test("a row not pushed and with no worktree is declared only", () => {
    const none: Sh = () => ({ ok: false, err: "", out: "" });
    expect(touchedFiles(none, "/repo", { branch: "b", worktree: "/no/such/worktree" })).toBeNull();
    expect(renderOverlap({ kind: "checked", rows: [{ ref: "OS-1", row: 3, paths: ["a.ts", "b.ts"], declaredOnly: true }] })).toEqual(["overlap: OS-1 (#3) a.ts, b.ts (declared only)"]);
  });
});

describe("the dispatch overlap warning (OS-47)", () => {
  test("no shared file: the dispatch prints nothing and records nothing, and launches", async () => {
    const w = await world();
    await check(w.dbPath, w.ids.mine, ["docs/unrelated.md"]);
    const r = await dispatch(w.dbPath, w.ids.mine, w.repo);
    expect(r.code).toBe(0);
    expect(r.launches).toBe(1);
    expect(r.err + r.out).not.toContain("overlap:");
    expect(await overlapDecisions(w.dbPath, w.ids.mine)).toEqual([]);
  });

  test("a shared exact path: one overlap line, one overlap decision, and the dispatch still launches", async () => {
    const w = await world();
    await check(w.dbPath, w.ids.mine, ["apps/a.ts"]);
    const r = await dispatch(w.dbPath, w.ids.mine, w.repo);
    expect(r.code).toBe(0);
    expect(r.launches).toBe(1);
    expect(r.err).toContain(`overlap: ${w.rowA.ticket_ref} (#${w.rowA.id}) apps/a.ts`);
    expect(r.err).not.toContain(w.rowB.ticket_ref);
    const decisions = await overlapDecisions(w.dbPath, w.ids.mine);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.rows).toEqual([{ ref: w.rowA.ticket_ref, row: w.rowA.id, paths: ["apps/a.ts"] }]);
  });

  test("a dir entry on a live row matches a file under it; a shared bun.lock alone is no overlap", async () => {
    const w = await world();
    await check(w.dbPath, w.ids.mine, ["platform/cli-coord/src/x.ts", "bun.lock"]);
    const r = await preview(w.dbPath, w.ids.mine, w.repo);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([`overlap: ${w.rowB.ticket_ref} (#${w.rowB.id}) platform/cli-coord/src/x.ts`]);
  });

  test("a dir/** entry on the ticket matches a file a live row declares", async () => {
    const w = await world();
    await check(w.dbPath, w.ids.mine, ["apps/**"]);
    const r = await preview(w.dbPath, w.ids.mine, w.repo);
    expect(r.out).toContain(`overlap: ${w.rowA.ticket_ref} (#${w.rowA.id}) apps/a.ts`);
  });

  test("a row in another repo and a landed row are ignored", async () => {
    const w = await world();
    await check(w.dbPath, w.ids.mine, ["shared.ts"]);
    const r = await dispatch(w.dbPath, w.ids.mine, w.repo);
    expect(r.code).toBe(0);
    expect(r.err + r.out).not.toContain("overlap:");
    expect(await overlapDecisions(w.dbPath, w.ids.mine)).toEqual([]);
  });

  test("a file the live row's pushed branch touched counts though its check never declared it", async () => {
    const w = await world({ "build-placeholder": [] });
    await check(w.dbPath, w.ids.mine, ["apps/b-only.ts"]);
    const r = await preview(w.dbPath, w.ids.mine, w.repo, { [w.rowB.branch]: ["apps/b-only.ts", "platform/y.ts"] });
    expect(r.out.trim().split("\n")).toEqual([`overlap: ${w.rowB.ticket_ref} (#${w.rowB.id}) apps/b-only.ts`]);
  });

  test("the preview prints the dispatch's lines, launches nothing, exits 0, and records nothing; --json for scripts", async () => {
    const w = await world();
    await check(w.dbPath, w.ids.mine, ["apps/a.ts", "platform/z.ts"]);
    const r = await preview(w.dbPath, w.ids.mine, w.repo);
    expect(r.code).toBe(0);
    expect(r.launches).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([`overlap: ${w.rowA.ticket_ref} (#${w.rowA.id}) apps/a.ts`, `overlap: ${w.rowB.ticket_ref} (#${w.rowB.id}) platform/z.ts`]);
    expect(await overlapDecisions(w.dbPath, w.ids.mine)).toEqual([]);
    const json = await preview(w.dbPath, w.ids.mine, w.repo, {}, ["--json"]);
    const parsed = JSON.parse(json.out);
    expect(parsed.checked).toBe(true);
    expect(parsed.rows).toEqual([
      { ref: w.rowA.ticket_ref, row: w.rowA.id, paths: ["apps/a.ts"], declared_only: false },
      { ref: w.rowB.ticket_ref, row: w.rowB.id, paths: ["platform/z.ts"], declared_only: false },
    ]);
    const db = openDb(w.dbPath);
    expect((await listSpinoffs(db)).some((row) => row.item_id === w.ids.mine)).toBe(false);
    db.close();
  });

  test("a row of the ticket's own item under another ref (a trial's leg b) is not an overlap with itself", async () => {
    const w = await world();
    await check(w.dbPath, w.ids.mine, ["apps/a.ts"]);
    expect((await dispatch(w.dbPath, w.ids.mine, w.repo)).code).toBe(0);
    const db = openDb(w.dbPath);
    const own = (await listSpinoffs(db)).find((r) => r.item_id === w.ids.mine)!;
    db.query("UPDATE spinoff SET ticket_ref = ? WHERE id = ?").run(`${own.ticket_ref}-b`, own.id);
    db.close();
    const r = await preview(w.dbPath, w.ids.mine, w.repo);
    expect(r.out.trim().split("\n")).toEqual([`overlap: ${w.rowA.ticket_ref} (#${w.rowA.id}) apps/a.ts`]);
  });

  test("no recorded check, or --no-check: overlap unknown, and the dispatch launches", async () => {
    const w = await world();
    const none = await preview(w.dbPath, w.ids.mine, w.repo);
    expect(none.code).toBe(0);
    expect(none.out.trim()).toBe("overlap: unknown, no recorded check");
    const r = await dispatch(w.dbPath, w.ids.mine, w.repo, {}, ["--no-check", "trusted by hand"]);
    expect(r.code).toBe(0);
    expect(r.launches).toBe(1);
    expect(r.err).toContain("overlap: unknown, no recorded check");
  });
});

// --- the API client: rows and declared files over the API, diffs from this machine's checkout ---------------------

const BASE = "https://ob.example.test";

describe("ob spinoff overlap on an API client (OS-47)", () => {
  test("the preview prints the same lines from rows and declared files over the API, and posts nothing", async () => {
    const repo = tempDir("os47-api-");
    mkdirSync(join(repo, ".git"));
    const rows = [
      { id: 4, ticket_ref: "OS-90", item_id: "90", repo: "omnislash", branch: "os-90", worktree: "/gone", status: "launched" },
      { id: 5, ticket_ref: "OS-91", item_id: "91", repo: "omnislash", branch: "os-91", worktree: "/gone", status: "merged" },
    ];
    const declared: Record<string, string[] | null> = { "OS-47": ["apps/cli/src/cli.ts"], "OS-90": ["apps/cli/"], "OS-91": ["apps/cli/src/cli.ts"] };
    const calls: string[] = [];
    const transport: ApiTransport = async (req: ApiRequest) => {
      const key = `${req.method} ${req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!}`;
      const body = req.body ? JSON.parse(req.body) : {};
      calls.push(body.op ? `${key} ${body.op}` : key);
      if (key === "GET /spinoffs/config") return { status: 200, body: JSON.stringify({ config: { repo_checkouts: { omnislash: repo }, launcher: "t3", launcher_by_repo: {}, engine: "claude" } }) };
      if (key === "GET /spinoffs") return { status: 200, body: JSON.stringify({ spinoffs: rows }) };
      if (key === "POST /spinoffs/overlap" && body.op === "declared") {
        return { status: 200, body: JSON.stringify({ op: "declared", declared: body.refs.map((r: { ticket_ref: string }) => ({ ticket_ref: r.ticket_ref, files: declared[r.ticket_ref] ?? null })) }) };
      }
      return { status: 404, body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }) };
    };
    const restoreSh = __setSh(gitSeam({ "os-90": ["apps/web/page.tsx"] }));
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "overlap", "OS-47", "--repo", "omnislash"], { api: { base: BASE, token: "t", transport } });
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe("overlap: OS-90 (#4) apps/cli/src/cli.ts");
      expect(calls.filter((c) => c.startsWith("POST") && c !== "POST /spinoffs/overlap declared")).toEqual([]);
    } finally {
      restoreSh();
    }
  });

  test("the server's POST /spinoffs/overlap reads declared files back and records one overlap decision", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const id = await createItem(db, { type: "task", title: "served", body: READY });
    db.close();
    await check(dbPath, id, ["apps/", "a.ts"]);
    const store = asStore(openDb(dbPath));
    const TOKEN = "a-test-bearer-token-that-is-long-enough";
    const app = createObApi({ store: async () => store, token: () => ({ token: TOKEN, path: "/nowhere", reason: null, message: null }) });
    const post = async (body: unknown) => {
      const res = await app(
        new Request(`http://host.test${OB_API_PREFIX}/spinoffs/overlap`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: res.status, body: (await res.json()) as any };
    };
    const read = await post({ op: "declared", refs: [{ ticket_ref: id, item_id: null }, { ticket_ref: "ZZ-404", item_id: null }] });
    expect(read.body).toEqual({ op: "declared", declared: [{ ticket_ref: id, files: ["a.ts", "apps/"] }, { ticket_ref: "ZZ-404", files: null }] });
    const rows = [{ ref: "OS-90", row: 4, paths: ["apps/x.ts"] }];
    const recorded = await post({ op: "record", ticket_ref: id, rows, note: "overlap: OS-90 (#4) apps/x.ts", actor: "architect-x" });
    expect(recorded.body).toEqual({ op: "record", recorded: true });
    const decisions = await overlapDecisions(dbPath, id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.rows).toEqual(rows);
  });
});

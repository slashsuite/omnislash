// OS-48: running builders' pushed branches are test-merged against each other with `git merge-tree`, and only a
// real merge conflict counts. `ob spinoff conflicts` prints the pairs; `role tick` posts each pair once per pair of
// heads to the team's sentinel and notes both tickets.
//
// Real git on a throwaway fixture: a bare `origin` and its clone in a temp directory, so no network and no live repo.
// The store is a fresh SQLite file and T3 is the fake seam.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import type { RoleMessage } from "../../../apps/cli/src/inbox.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { overlapSh } from "../src/commands/spinoff.ts";
import { conflictedPaths, conflictKey, findBranchConflicts } from "../src/spinoff-conflicts.ts";
import type { OverlapRow } from "../src/spinoff-overlap.ts";

const scratch = (): string => process.env.TMPDIR || tmpdir();
const cleanup: Array<() => void> = [];
let prevHome: string | undefined;

beforeEach(() => {
  // The tick's night lock is read from $HOME: an empty home keeps the desktop's own lock out.
  prevHome = process.env.HOME;
  const home = tempDir("os48-home-");
  process.env.HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  while (cleanup.length) cleanup.pop()!();
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(scratch(), prefix));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
/** `f.txt` with line `n` (1-based) replaced. */
const fWith = (n: number, text: string): string => TEN.map((l, i) => (i === n - 1 ? text : l)).join("\n") + "\n";

/** A bare origin and a clone (`<root>/cfp`) whose `main` holds a ten line `f.txt` and a `bun.lock`. */
function fixture(): { origin: string; clone: string } {
  const root = tempDir("os48-repo-");
  const origin = join(root, "origin.git");
  const clone = join(root, "cfp");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, clone);
  git(clone, "checkout", "-q", "-B", "main");
  writeFileSync(join(clone, "f.txt"), TEN.join("\n") + "\n");
  writeFileSync(join(clone, "bun.lock"), "lock 0\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "base");
  git(clone, "push", "-q", "origin", "main");
  return { origin, clone };
}

/** Push `branch` off main with `files` written, return its head. With `amend` it builds on the branch's head instead. */
function push(clone: string, branch: string, files: Record<string, string>, from = "main"): string {
  git(clone, "checkout", "-q", "-B", branch, from);
  for (const [p, body] of Object.entries(files)) writeFileSync(join(clone, p), body);
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", `edit on ${branch}`);
  git(clone, "push", "-q", "-f", "origin", branch);
  const sha = git(clone, "rev-parse", "HEAD");
  git(clone, "checkout", "-q", "main");
  return sha;
}

function row(id: number, ref: string, branch: string, repo: string, status = "launched"): OverlapRow {
  return { id, ticket_ref: ref, item_id: null, repo, branch, worktree: "/gone", status };
}

const deps = { sh: overlapSh, repoPath: (r: string) => r };

describe("conflictedPaths (OS-48), pure", () => {
  test("skips the tree id, stops at the blank line and dedupes", () => {
    const out = ["0123abcd", "b.ts", "a.ts", "a.ts", "apps/bun.lock", "", "Auto-merging a.ts", "CONFLICT (content): Merge conflict in a.ts"].join("\n");
    expect(conflictedPaths(out)).toEqual(["a.ts", "apps/bun.lock", "b.ts"]);
    expect(conflictedPaths("0123abcd\n\nCONFLICT (directory rename split)")).toEqual([]);
  });
});

describe("findBranchConflicts on a fixture repo (OS-48)", () => {
  test("one file edited at different lines is no conflict; the same line is one, naming the file", async () => {
    const { clone } = fixture();
    push(clone, "a", { "f.txt": fWith(1, "a was here") });
    push(clone, "b", { "f.txt": fWith(9, "b was here") });
    const clean = await findBranchConflicts([row(1, "OS-1", "a", clone), row(2, "OS-2", "b", clone)], deps);
    expect(clean).toEqual({ conflicts: [], warnings: [], unpushed: [] });

    const headC = push(clone, "c", { "f.txt": fWith(1, "c disagrees") });
    const headA = git(clone, "rev-parse", "origin/a");
    const hit = await findBranchConflicts([row(3, "OS-3", "c", clone), row(1, "OS-1", "a", clone)], deps);
    expect(hit.warnings).toEqual([]);
    expect(hit.conflicts).toEqual([
      { repo: clone, a: { row: 1, ref: "OS-1", item_id: null, branch: "a", head: headA }, b: { row: 3, ref: "OS-3", item_id: null, branch: "c", head: headC }, files: ["f.txt"] },
    ]);
    expect(conflictKey(hit.conflicts[0]!)).toBe(`conflict:1:${headA}:3:${headC}`);
  }, spawnBudget(12));

  test("a lockfile-only conflict, an unpushed branch, a landed row and one ticket's two legs report nothing", async () => {
    const { clone } = fixture();
    push(clone, "a", { "bun.lock": "lock a\n" });
    push(clone, "b", { "bun.lock": "lock b\n" });
    push(clone, "x", { "f.txt": fWith(1, "x") });
    push(clone, "x-b", { "f.txt": fWith(1, "x-b") });
    push(clone, "done", { "f.txt": fWith(1, "landed") });
    const check = await findBranchConflicts(
      [row(1, "OS-1", "a", clone), row(2, "OS-2", "b", clone), row(3, "OS-3", "never-pushed", clone), row(4, "OS-4", "x", clone), row(5, "OS-4", "x-b", clone), row(6, "OS-6", "done", clone, "merged")],
      deps,
    );
    // OS-4's two legs conflict with each other only, and the landed row is not running.
    expect(check).toEqual({ conflicts: [], warnings: [], unpushed: [{ row: 3, ref: "OS-3", branch: "never-pushed" }] });
  }, spawnBudget(16));

  test("a repo with no checkout on this machine is skipped without a warning", async () => {
    const check = await findBranchConflicts([row(1, "OS-1", "a", "elsewhere"), row(2, "OS-2", "b", "elsewhere")], deps);
    expect(check).toEqual({ conflicts: [], warnings: [], unpushed: [] });
  });
});

// --- the command and the tick against a store ---------------------------------------------------------------------

async function messages(store: Store): Promise<RoleMessage[]> {
  const t = store.t.roleMessage;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleMessage[];
}

/** Team `t` with project `cfp` checked out at the fixture clone, and two running rows on branches `a` and `b`. */
async function world() {
  const fx = fixture();
  const dbPath = freshDbPath();
  const store = sqliteStoreFor(openDb(dbPath, { create: true }));
  expect((await runCli(dbPath, ["project", "add", "cfp", "--kind", "side"])).code).toBe(0);
  expect((await runCli(dbPath, ["t3", "team", "add", "t", "--projects", "cfp"])).code).toBe(0);
  await setConfig(store, "repo_checkouts", JSON.stringify({ cfp: fx.clone }));
  const ids: string[] = [];
  for (const [ref, branch] of [["CF-1", "a"], ["CF-2", "b"]] as const) {
    const id = await createItem(store, { type: "task", title: ref, body: "b", projectId: "cfp" });
    ids.push(id);
    // No launcher: the stale-builder finding reads t3 rows only, so the architect has nothing and only the conflict shows.
    await store.q.insert(store.t.spinoff).values({ ticket_ref: ref, item_id: id, repo: "cfp", branch, worktree: `/wt/${branch}`, mode: "interactive", brief: "b", status: "launched", launcher: null, request_at: new Date().toISOString() });
  }
  return { ...fx, dbPath, store, ids };
}

const noteLines = async (store: Store, id: string): Promise<string[]> => ((await getItem(store, id))?.body ?? "").split("\n").filter((l) => l.includes("] conflict: "));

describe("ob spinoff conflicts (OS-48)", () => {
  test("prints one line per conflicting pair, or conflicts: none; it records nothing", async () => {
    const { clone, dbPath, store } = await world();
    push(clone, "a", { "f.txt": fWith(1, "a") });
    push(clone, "b", { "f.txt": fWith(9, "b") });
    const none = await runCli(dbPath, ["spinoff", "conflicts"]);
    expect(none.code).toBe(0);
    expect(none.out.trim()).toBe("conflicts: none");

    const headB = push(clone, "b", { "f.txt": fWith(1, "b") });
    const headA = git(clone, "rev-parse", "origin/a");
    const hit = await runCli(dbPath, ["spinoff", "conflicts", "--repo", "cfp"]);
    expect(hit.code).toBe(0);
    expect(hit.out.trim()).toBe(`conflict: CF-1 (${headA.slice(0, 7)}) and CF-2 (${headB.slice(0, 7)}): f.txt`);
    const json = JSON.parse((await runCli(dbPath, ["spinoff", "conflicts", "--json"])).out);
    expect(json.conflicts).toHaveLength(1);
    expect(json.conflicts[0].files).toEqual(["f.txt"]);
    expect(await messages(store)).toEqual([]);
  }, spawnBudget(16));

  test("over the API the rows come from the server and the merge runs in this machine's checkout", async () => {
    const { clone } = fixture();
    push(clone, "a", { "f.txt": fWith(1, "a") });
    push(clone, "b", { "f.txt": fWith(1, "b") });
    const rows = [
      { id: 4, ticket_ref: "OS-90", item_id: "90", repo: "omnislash", branch: "a", worktree: "/gone", status: "launched" },
      { id: 5, ticket_ref: "OS-91", item_id: "91", repo: "omnislash", branch: "b", worktree: "/gone", status: "ready-for-gate" },
    ];
    const BASE = "https://ob.example.test";
    const calls: string[] = [];
    const transport: ApiTransport = async (req: ApiRequest) => {
      const key = `${req.method} ${req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!}`;
      calls.push(key);
      if (key === "GET /spinoffs/config") return { status: 200, body: JSON.stringify({ config: { repo_checkouts: { omnislash: clone }, launcher: "t3", launcher_by_repo: {}, engine: "claude" } }) };
      if (key === "GET /spinoffs") return { status: 200, body: JSON.stringify({ spinoffs: rows }) };
      return { status: 404, body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }) };
    };
    const r = await runCli(freshDbPath(), ["spinoff", "conflicts", "--repo", "omnislash"], { api: { base: BASE, token: "t", transport } });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^conflict: OS-90 \([0-9a-f]{7}\) and OS-91 \([0-9a-f]{7}\): f\.txt$/);
    expect(calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
    const typo = await runCli(freshDbPath(), ["spinoff", "conflicts", "--repo", "no-such-repo"], { api: { base: BASE, token: "t", transport } });
    expect(typo.code).not.toBe(0);
  }, spawnBudget(12));
});

describe("role tick posts branch conflicts to the sentinel (OS-48)", () => {
  test("one sentinel message and one note per ticket; same heads post nothing; a new conflicting head posts once more", async () => {
    const w = await world();
    const f = installFakeT3([w.clone]);
    cleanup.push(() => f.restore());
    const headA = push(w.clone, "a", { "f.txt": fWith(1, "a") });
    let headB = push(w.clone, "b", { "f.txt": fWith(1, "b") });

    const first = await runCli(w.dbPath, ["role", "tick"]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toContain(`role tick t: wrote #1 conflict: CF-1 (${headA.slice(0, 7)}) and CF-2 (${headB.slice(0, 7)}): f.txt`);
    expect(first.out).toContain("role tick t sentinel: run 1 opened");
    let rows = await messages(w.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "sentinel", from_actor: "tick", ref: "CF-1", client_key: `conflict:1:${headA}:2:${headB}` });
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]!.message).toContain("conflict: CF-1");
    expect(await noteLines(w.store, w.ids[0]!)).toHaveLength(1);
    expect((await noteLines(w.store, w.ids[0]!))[0]).toContain(`conflict: CF-2 at ${headA.slice(0, 7)}/${headB.slice(0, 7)}: f.txt`);
    expect((await noteLines(w.store, w.ids[1]!))[0]).toContain(`conflict: CF-1 at ${headA.slice(0, 7)}/${headB.slice(0, 7)}: f.txt`);

    const second = await runCli(w.dbPath, ["role", "tick"]);
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("wrote #");
    expect(await messages(w.store)).toHaveLength(1);
    expect(await noteLines(w.store, w.ids[0]!)).toHaveLength(1);
    expect(f.launches).toHaveLength(1);

    headB = push(w.clone, "b", { "f.txt": fWith(1, "b again") }, "b");
    const third = await runCli(w.dbPath, ["role", "tick"]);
    expect(third.code).toBe(0);
    rows = await messages(w.store);
    expect(rows).toHaveLength(2);
    expect(third.out).toContain(`role tick t: wrote #${rows[1]!.id} conflict: CF-1 (${headA.slice(0, 7)}) and CF-2 (${headB.slice(0, 7)}): f.txt`);
    expect(rows[1]!.client_key).toBe(`conflict:1:${headA}:2:${headB}`);
    expect(await noteLines(w.store, w.ids[0]!)).toHaveLength(2);
    expect(await noteLines(w.store, w.ids[1]!)).toHaveLength(2);
  }, spawnBudget(30));

  test("a git failure warns and the tick still succeeds", async () => {
    const w = await world();
    const f = installFakeT3([w.clone]);
    cleanup.push(() => f.restore());
    push(w.clone, "a", { "f.txt": fWith(1, "a") });
    push(w.clone, "b", { "f.txt": fWith(1, "b") });
    git(w.clone, "remote", "set-url", "origin", join(w.clone, "no-such-origin"));
    const r = await runCli(w.dbPath, ["role", "tick"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("role tick t: conflicts: git fetch in");
    expect(r.out.trim()).toBe("role tick t: nothing new");
    expect(await messages(w.store)).toEqual([]);
    expect(f.launches).toHaveLength(0);
  }, spawnBudget(16));
});

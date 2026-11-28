// OS-48: running builders' pushed branches are test-merged against each other with `git merge-tree`, and only a
// real merge conflict counts. `ob spinoff conflicts` prints the pairs; `role tick` posts each pair once to the team's
// sentinel and notes both tickets. OS-259: the tick pauses the pair's loser and resumes it after the winner lands.
//
// Real git on a throwaway fixture: a bare `origin` and its clone in a temp directory, so no network and no live repo.
// The store is a fresh SQLite file and T3 is the fake seam.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { nightLockPath } from "../../../apps/cli/src/role-deliver.ts";
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
import { conflictedPaths, conflictKey, conflictPairKey, findBranchConflicts, isResolvedAtLand, openYields, pickLoser, type ConflictSide } from "../src/spinoff-conflicts.ts";
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
    expect(clean).toEqual({ conflicts: [], warnings: [], unpushed: [], landed: [] });

    const headC = push(clone, "c", { "f.txt": fWith(1, "c disagrees") });
    const headA = git(clone, "rev-parse", "origin/a");
    const hit = await findBranchConflicts([row(3, "OS-3", "c", clone), row(1, "OS-1", "a", clone)], deps);
    expect(hit.warnings).toEqual([]);
    expect(hit.conflicts).toEqual([
      { repo: clone, a: { row: 1, ref: "OS-1", item_id: null, branch: "a", head: headA, thread: null }, b: { row: 3, ref: "OS-3", item_id: null, branch: "c", head: headC, thread: null }, files: ["f.txt"] },
    ]);
    // OS-259: the pair key is the rows; OS-263: the message key adds the heads it was found at.
    expect(conflictPairKey(hit.conflicts[0]!)).toBe("conflict:1:3");
    expect(conflictKey(hit.conflicts[0]!, 3)).toBe(`conflict:1:3:loser:3:${headA.slice(0, 12)}:${headC.slice(0, 12)}`);
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
    expect(check).toEqual({ conflicts: [], warnings: [], unpushed: [{ row: 3, ref: "OS-3", branch: "never-pushed" }], landed: [] });
  }, spawnBudget(16));

  // OS-259: a merged or squash-landed branch is no longer running, whatever its row says.
  test("a branch already on origin/main (squashed or merged) is landed and left out of the pairs", async () => {
    const { clone } = fixture();
    push(clone, "a", { "f.txt": fWith(1, "a") });
    push(clone, "b", { "f.txt": fWith(1, "b") });
    // Squash a onto main by hand: main gains a's change in a new commit, so a's head is no ancestor of it.
    writeFileSync(join(clone, "f.txt"), fWith(1, "a"));
    git(clone, "commit", "-q", "-am", "squash a");
    git(clone, "push", "-q", "origin", "main");
    const squashed = await findBranchConflicts([row(1, "OS-1", "a", clone), row(2, "OS-2", "b", clone, "ready-for-gate")], deps);
    expect(squashed).toEqual({ conflicts: [], warnings: [], unpushed: [], landed: [{ row: 1, ref: "OS-1", branch: "a" }] });

    // A fast-forward merge: the head is an ancestor of main.
    const headC = push(clone, "c", { "f.txt": fWith(5, "c") });
    git(clone, "push", "-q", "origin", `${headC}:refs/heads/main`);
    push(clone, "d", { "f.txt": fWith(5, "d") }, headC);
    const merged = await findBranchConflicts([row(3, "OS-3", "c", clone), row(4, "OS-4", "d", clone)], deps);
    expect(merged).toEqual({ conflicts: [], warnings: [], unpushed: [], landed: [{ row: 3, ref: "OS-3", branch: "c" }] });
  }, spawnBudget(16));

  test("a repo with no checkout on this machine is skipped without a warning", async () => {
    const check = await findBranchConflicts([row(1, "OS-1", "a", "elsewhere"), row(2, "OS-2", "b", "elsewhere")], deps);
    expect(check).toEqual({ conflicts: [], warnings: [], unpushed: [], landed: [] });
  });

  // OS-188: FACTS.md's "Checked against" line is bumped by every PR and resolved at land, so it is not a conflict.
  test("a conflict only in FACTS.md is clean; FACTS.md plus a real file reports just the real file", async () => {
    const { clone } = fixture();
    writeFileSync(join(clone, "FACTS.md"), "# Facts\n\nChecked against: aaaaaaa\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "facts");
    git(clone, "push", "-q", "origin", "main");

    push(clone, "a", { "FACTS.md": "# Facts\n\nChecked against: 1111111\n" });
    push(clone, "b", { "FACTS.md": "# Facts\n\nChecked against: 2222222\n" });
    const clean = await findBranchConflicts([row(1, "OS-1", "a", clone), row(2, "OS-2", "b", clone)], deps);
    expect(clean).toEqual({ conflicts: [], warnings: [], unpushed: [], landed: [] });

    push(clone, "c", { "FACTS.md": "# Facts\n\nChecked against: 3333333\n", "f.txt": fWith(1, "c") });
    push(clone, "d", { "FACTS.md": "# Facts\n\nChecked against: 4444444\n", "f.txt": fWith(1, "d") });
    const headC = git(clone, "rev-parse", "origin/c");
    const headD = git(clone, "rev-parse", "origin/d");
    const hit = await findBranchConflicts([row(3, "OS-3", "c", clone), row(4, "OS-4", "d", clone)], deps);
    expect(hit.warnings).toEqual([]);
    expect(hit.conflicts).toHaveLength(1);
    expect(hit.conflicts[0]!.files).toEqual(["f.txt"]);
    expect(hit.conflicts[0]!.a.head).toBe(headC);
    expect(hit.conflicts[0]!.b.head).toBe(headD);
  }, spawnBudget(16));
});

test("resolvedAtLand: lockfiles and FACTS.md are; other files are not (OS-188), pure", () => {
  expect(isResolvedAtLand("bun.lock")).toBe(true);
  expect(isResolvedAtLand("apps/cli/package-lock.json")).toBe(true);
  expect(isResolvedAtLand("FACTS.md")).toBe(true);
  expect(isResolvedAtLand("docs/FACTS.md")).toBe(false);
  expect(isResolvedAtLand("FACTS.mdx")).toBe(false);
  expect(isResolvedAtLand("apps/cli/src/cli.ts")).toBe(false);
});

describe("pickLoser and openYields (OS-259), pure", () => {
  const side = (row: number): ConflictSide => ({ row, ref: `OS-${row}`, item_id: null, branch: `b${row}`, head: "h", thread: null });
  const pair = { a: side(1), b: side(2) };
  test("the better priority wins; at equal priority the lower row (queued first) wins", () => {
    // urgent 1, high 2, flake 5, critical 6, none 0
    expect(pickLoser(pair, 2, 1).loser.row).toBe(1);
    expect(pickLoser(pair, 1, 2).loser.row).toBe(2);
    expect(pickLoser(pair, 1, 6).loser.row).toBe(1); // critical beats urgent
    expect(pickLoser(pair, 2, 5).loser.row).toBe(1); // flake beats high
    expect(pickLoser(pair, null, 4).loser.row).toBe(1); // low beats none
    expect(pickLoser(pair, 3, 3)).toEqual({ winner: pair.a, loser: pair.b });
    expect(pickLoser(pair, null, 0)).toEqual({ winner: pair.a, loser: pair.b });
  });
  test("a pause stays open until a resume notice for its loser comes after it", () => {
    const m = (id: number, client_key: string | null) => ({ id, client_key });
    expect(openYields([m(1, "conflict:1:2:loser:2"), m(2, "conflict:2:5:loser:2"), m(3, "conflict:3:4:loser:3"), m(4, null), m(5, "tick:x")])).toEqual(
      new Map([
        [2, [1, 5]],
        [3, [4]],
      ]),
    );
    expect(openYields([m(1, "conflict:1:2:loser:2"), m(2, "resume:2:1")])).toEqual(new Map());
    // A later pause after a resume is open again; an old head-keyed key (OS-48) is not a pause.
    expect(openYields([m(1, "conflict:1:2:loser:2"), m(2, "resume:2:1"), m(3, "conflict:2:7:loser:2"), m(4, "conflict:1:abc:2:def")])).toEqual(new Map([[2, [7]]]));
  });
});

// --- the command and the tick against a store ---------------------------------------------------------------------

async function messages(store: Store): Promise<RoleMessage[]> {
  const t = store.t.roleMessage;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleMessage[];
}

/** Team `t` with project `cfp` checked out at the fixture clone, and two running rows on branches `a` and `b`. */
async function world(opts: { priorities?: [number | null, number | null]; threads?: boolean } = {}) {
  const fx = fixture();
  const dbPath = freshDbPath();
  const store = sqliteStoreFor(openDb(dbPath, { create: true }));
  expect((await runCli(dbPath, ["project", "add", "cfp", "--kind", "side"])).code).toBe(0);
  expect((await runCli(dbPath, ["t3", "team", "add", "t", "--projects", "cfp"])).code).toBe(0);
  await setConfig(store, "repo_checkouts", JSON.stringify({ cfp: fx.clone }));
  const ids: string[] = [];
  for (const [i, [ref, branch]] of ([["CF-1", "a"], ["CF-2", "b"]] as const).entries()) {
    const id = await createItem(store, { type: "task", title: ref, body: "b", projectId: "cfp", priority: opts.priorities?.[i] ?? null });
    ids.push(id);
    // No launcher: the stale-builder finding reads t3 rows only, so the architect has nothing and only the conflict shows.
    await store.q.insert(store.t.spinoff).values({ ticket_ref: ref, item_id: id, repo: "cfp", branch, worktree: `/wt/${branch}`, mode: "interactive", brief: "b", status: "launched", launcher: opts.threads ? "t3" : null, t3_thread_id: opts.threads ? `bt-${i + 1}` : null, request_at: new Date().toISOString() });
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
  test("one sentinel message and one note per ticket; a pair is posted once, however its heads move", async () => {
    const w = await world();
    const f = installFakeT3([w.clone]);
    cleanup.push(() => f.restore());
    const headA = push(w.clone, "a", { "f.txt": fWith(1, "a") });
    let headB = push(w.clone, "b", { "f.txt": fWith(1, "b") });

    const first = await runCli(w.dbPath, ["role", "tick"]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    // No priority on either: row 1 was queued first and wins.
    expect(first.out).toContain(`role tick t: wrote #1 conflict: CF-1 (${headA.slice(0, 7)}) and CF-2 (${headB.slice(0, 7)}): f.txt; CF-2 gives way to CF-1`);
    expect(first.out).toContain("role tick t sentinel: run 1 opened");
    const rows = await messages(w.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "sentinel", from_actor: "tick", ref: "CF-1", client_key: `conflict:1:2:loser:2:${headA.slice(0, 12)}:${headB.slice(0, 12)}` });
    // Neither row has a T3 thread: the message says to pause it by hand, and nothing is interrupted.
    expect(rows[0]!.body).toContain("CF-1 (none) wins over CF-2 (none, equal priority and row 1 queued first); CF-2 (row 2) has no builder thread ob could tell: pause it by hand");
    expect(f.interrupts).toEqual([]);
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]!.message).toContain("conflict: CF-1");
    expect(await noteLines(w.store, w.ids[0]!)).toHaveLength(1);
    expect((await noteLines(w.store, w.ids[0]!))[0]).toContain(`conflict: CF-2 at ${headA.slice(0, 7)}/${headB.slice(0, 7)}: f.txt; CF-2 gives way`);
    expect((await noteLines(w.store, w.ids[1]!))[0]).toContain(`conflict: CF-1 at ${headA.slice(0, 7)}/${headB.slice(0, 7)}: f.txt; CF-2 gives way`);

    const second = await runCli(w.dbPath, ["role", "tick"]);
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("wrote #");
    expect(await messages(w.store)).toHaveLength(1);

    // OS-259: new heads on the same pair are the same pair, still being handled: nothing more is posted.
    headB = push(w.clone, "b", { "f.txt": fWith(1, "b again") }, "b");
    const third = await runCli(w.dbPath, ["role", "tick"]);
    expect(third.code).toBe(0);
    expect(third.out).not.toContain("wrote #");
    expect(await messages(w.store)).toHaveLength(1);
    expect(await noteLines(w.store, w.ids[0]!)).toHaveLength(1);
    expect(await noteLines(w.store, w.ids[1]!)).toHaveLength(1);
    expect(f.launches).toHaveLength(1);
  }, spawnBudget(30));

  // OS-259: the live miss. Urgent beats high, the loser's thread is stopped and told to wait, and once the winner
  // squash-lands on main the loser is told to rebase and go on, once.
  test("the loser is paused on its thread, and resumed after the winner lands on main", async () => {
    // CF-1 (row 1) high, CF-2 (row 2) urgent: CF-2 wins although it was queued second.
    const w = await world({ priorities: [2, 1], threads: true });
    const f = installFakeT3([w.clone]);
    cleanup.push(() => f.restore());
    const heads = `${push(w.clone, "a", { "f.txt": fWith(1, "a") }).slice(0, 12)}:${push(w.clone, "b", { "f.txt": fWith(1, "b") }).slice(0, 12)}`;
    const toLoser = () => f.sends.filter((s) => s.threadId === "bt-1");

    const first = await runCli(w.dbPath, ["role", "tick"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("CF-1 gives way to CF-2");
    expect(f.interrupts).toEqual(["bt-1"]);
    expect(toLoser()).toHaveLength(1);
    expect(toLoser()[0]).toMatchObject({ mode: "queue", clientRequestId: `ob-yield-bt-1-1-2-${heads.replace(":", "-")}` });
    expect(toLoser()[0]!.message).toContain('--status blocked --note "yielding to CF-2"');
    expect(toLoser()[0]!.message).toContain("CF-2 (urgent) wins over CF-1 (high)");
    expect(f.sends.some((s) => s.threadId === "bt-2")).toBe(false);
    let rows = await messages(w.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_key).toBe(`conflict:1:2:loser:1:${heads}`);
    expect(rows[0]!.body).toContain("CF-2 (urgent) wins over CF-1 (high); CF-1 (row 1) is paused and resumes by itself after CF-2 lands.");

    // The winner moves on: the pair is not posted again and the loser is not told twice.
    push(w.clone, "b", { "f.txt": fWith(1, "b final") }, "b");
    const second = await runCli(w.dbPath, ["role", "tick"]);
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("wrote #");
    expect(f.interrupts).toEqual(["bt-1"]);
    expect(toLoser()).toHaveLength(1);

    // The winner squash-lands on main; its row still reads handed-off, its branch is still on origin.
    git(w.clone, "checkout", "-q", "main");
    git(w.clone, "merge", "-q", "--squash", "origin/b");
    git(w.clone, "-c", "user.name=t", "commit", "-q", "-m", "CF-2 (#1)");
    git(w.clone, "push", "-q", "origin", "main");
    await w.store.q.update(w.store.t.spinoff).set({ status: "ready-for-gate" }).where(eq(w.store.t.spinoff.ticket_ref, "CF-2"));
    const third = await runCli(w.dbPath, ["role", "tick"]);
    expect(third.err).toBe("");
    expect(third.code).toBe(0);
    rows = await messages(w.store);
    const resume = rows.find((m) => m.client_key === `resume:1:2:${rows[0]!.id}`);
    expect(resume).toBeDefined();
    expect(third.out).toContain(`role tick t: wrote #${resume!.id} resume: CF-1 after CF-2`);
    expect(resume!.body).toContain("resume: CF-1 (row 1) goes on; CF-2 no longer running");
    expect(toLoser()).toHaveLength(2);
    expect(toLoser()[1]).toMatchObject({ mode: "queue", clientRequestId: `ob-resume-bt-1-1-2-${rows[0]!.id}` });
    expect(toLoser()[1]!.message).toContain("git fetch origin && git rebase origin/main");
    expect(toLoser()[1]!.message).toContain("needs-human");
    expect(f.interrupts).toEqual(["bt-1"]);
    // The landed row is dropped from the scan: CF-1 still conflicts with main's f.txt, but no new pair is posted.
    expect(rows.filter((m) => m.client_key?.startsWith("conflict:"))).toHaveLength(1);

    const fourth = await runCli(w.dbPath, ["role", "tick"]);
    expect(fourth.code).toBe(0);
    expect(fourth.out).not.toContain("wrote #");
    expect(toLoser()).toHaveLength(2);
  }, spawnBudget(40));

  test("at equal priority the row queued first wins; the loser resumes once the winner's row is landed", async () => {
    const w = await world({ priorities: [3, 3], threads: true });
    const f = installFakeT3([w.clone]);
    cleanup.push(() => f.restore());
    push(w.clone, "a", { "f.txt": fWith(1, "a") });
    push(w.clone, "b", { "f.txt": fWith(1, "b") });
    expect((await runCli(w.dbPath, ["role", "tick"])).code).toBe(0);
    expect(f.interrupts).toEqual(["bt-2"]);
    const first = (await messages(w.store))[0]!;
    expect(first.client_key).toMatch(/^conflict:1:2:loser:2:[0-9a-f]{12}:[0-9a-f]{12}$/);

    await w.store.q.update(w.store.t.spinoff).set({ status: "merged" }).where(eq(w.store.t.spinoff.ticket_ref, "CF-1"));
    const r = await runCli(w.dbPath, ["role", "tick"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("resume: CF-2 after CF-1");
    expect(f.sends.filter((s) => s.threadId === "bt-2").map((s) => s.clientRequestId)).toEqual([`ob-yield-bt-2-2-1-${first.client_key!.split(":").slice(5).join("-")}`, `ob-resume-bt-2-2-1-${first.id}`]);
  }, spawnBudget(30));

  // OS-263: the pair key never expired, so a pair resolved by a resume and conflicting again was never posted again.
  test("a pair resolved by a resume is posted again when it conflicts on new commits, never while it is unchanged", async () => {
    const w = await world({ priorities: [3, 3], threads: true });
    const f = installFakeT3([w.clone]);
    cleanup.push(() => f.restore());
    const toLoser = () => f.sends.filter((s) => s.threadId === "bt-2");
    const conflictsPosted = async () => (await messages(w.store)).filter((m) => m.client_key?.startsWith("conflict:"));
    const setCf1 = (status: string) => w.store.q.update(w.store.t.spinoff).set({ status }).where(eq(w.store.t.spinoff.ticket_ref, "CF-1"));
    push(w.clone, "a", { "f.txt": fWith(1, "a") });
    push(w.clone, "b", { "f.txt": fWith(1, "b") });
    expect((await runCli(w.dbPath, ["role", "tick"])).code).toBe(0);
    await setCf1("merged");
    expect((await runCli(w.dbPath, ["role", "tick"])).out).toContain("resume: CF-2 after CF-1");
    expect(toLoser()).toHaveLength(2);

    // CF-1 runs again at the heads the pair was posted at: unchanged, so nothing is posted and CF-2 is not paused.
    await setCf1("launched");
    const same = await runCli(w.dbPath, ["role", "tick"]);
    expect(same.code).toBe(0);
    expect(same.out).not.toContain("wrote #");
    expect(await conflictsPosted()).toHaveLength(1);
    expect(toLoser()).toHaveLength(2);

    // New commits on CF-1 that still conflict: the pair is posted again and CF-2 is paused again.
    const headA = push(w.clone, "a", { "f.txt": fWith(1, "a again") }, "a");
    const again = await runCli(w.dbPath, ["role", "tick"]);
    expect(again.err).toBe("");
    expect(again.code).toBe(0);
    expect(again.out).toContain(`conflict: CF-1 (${headA.slice(0, 7)})`);
    expect(again.out).toContain("CF-2 gives way to CF-1");
    const posted = await conflictsPosted();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.client_key).toStartWith(`conflict:1:2:loser:2:${headA.slice(0, 12)}:`);
    expect(f.interrupts).toEqual(["bt-2", "bt-2"]);
    expect(toLoser()).toHaveLength(3);
    expect(toLoser()[2]!.message).toContain("you give way until it lands");
    expect(new Set(toLoser().map((s) => s.clientRequestId)).size).toBe(3);
    expect(await noteLines(w.store, w.ids[0]!)).toHaveLength(2);

    // Still unchanged on the next tick: no repost.
    const quiet = await runCli(w.dbPath, ["role", "tick"]);
    expect(quiet.out).not.toContain("wrote #");
    expect(await conflictsPosted()).toHaveLength(2);

    // The second pause ends with its own resume, not swallowed by the first one's key.
    await setCf1("merged");
    const resumed = await runCli(w.dbPath, ["role", "tick"]);
    expect(resumed.out).toContain("resume: CF-2 after CF-1");
    expect(toLoser()).toHaveLength(4);
    expect(toLoser()[3]!.clientRequestId).toBe(`ob-resume-bt-2-2-1-${posted[1]!.id}`);
  }, spawnBudget(60));

  test("under the night lock the tick posts, pauses and resumes nothing", async () => {
    const w = await world({ threads: true });
    const f = installFakeT3([w.clone]);
    cleanup.push(() => f.restore());
    push(w.clone, "a", { "f.txt": fWith(1, "a") });
    push(w.clone, "b", { "f.txt": fWith(1, "b") });
    const lock = nightLockPath(process.env.HOME!);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, new Date(Date.now() + 3_600_000).toISOString());
    const r = await runCli(w.dbPath, ["role", "tick"]);
    expect(r.code).toBe(0);
    expect(await messages(w.store)).toEqual([]);
    expect(f.interrupts).toEqual([]);
    expect(f.sends).toEqual([]);
  }, spawnBudget(16));

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

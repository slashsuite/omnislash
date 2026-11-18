import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import {
  drainSpinoffs,
  enqueueSpinoff,
  listSpinoffs,
  renderDrainLines,
  resolveDrainScope,
  worktreePath,
  type SpinoffLaunchConfig,
} from "../src/commands/spinoff.ts";

// OB-1796: `ob spinoff drain` launches the caller's repo, not every repo's. Everything here runs against a
// fake T3 with each expected worktree pre-created, so nothing real launches and no network is touched.

const bases: string[] = [];
afterEach(() => {
  while (bases.length) rmSync(bases.pop()!, { recursive: true, force: true });
});

/** Two checkouts named A and B under one temp base, each a git repo as far as ob can tell. */
function twoRepos(): { base: string; a: string; b: string; cfg: Pick<SpinoffLaunchConfig, "repoCheckouts"> } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ob-drain-scope-")));
  bases.push(base);
  const a = join(base, "A");
  const b = join(base, "B");
  for (const dir of [a, b]) mkdirSync(join(dir, ".git"), { recursive: true });
  return { base, a, b, cfg: { repoCheckouts: { A: a, B: b } } };
}

async function queueBoth(db: ReturnType<typeof freshDb>, a: string, b: string): Promise<void> {
  await enqueueSpinoff(db, { ticketRef: "A-1", repo: a, branch: "a-1", mode: "interactive", brief: "x" });
  await enqueueSpinoff(db, { ticketRef: "B-1", repo: b, branch: "b-1", mode: "interactive", brief: "x" });
  mkdirSync(worktreePath(a, "a-1"), { recursive: true });
  mkdirSync(worktreePath(b, "b-1"), { recursive: true });
}

describe("OB-1796 drain scope", () => {
  test("a drain in repo A launches A's row and leaves B's queued, naming it as skipped", async () => {
    const { a, b, cfg } = twoRepos();
    const db = freshDb();
    await queueBoth(db, a, b);
    const t3 = installFakeT3([a, b]);
    try {
      const scope = resolveDrainScope(cfg, { cwd: a, home: "/nonexistent" });
      const r = await drainSpinoffs(db, "", {}, undefined, scope);
      expect(r.launched).toEqual(["A-1"]);
      expect(r.skipped_other_repo).toEqual([{ ticket: "B-1", repo: "B" }]);
      expect(r.scope).toBe("A");
      expect(t3.launches).toHaveLength(1);
      const rows = await listSpinoffs(db, "pending");
      expect(rows.map((s) => s.ticket_ref)).toEqual(["B-1"]); // still queued: never claimed, never failed
      const text = renderDrainLines(r, { merged: [], blocked: [], mirrored: [], db_failures: [] } as never).join("\n");
      expect(text).toContain("B-1: skipped, queued for repo B, not A");
    } finally {
      t3.restore();
    }
  });

  test("--repo names the repo the same way the cwd would", async () => {
    const { a, b, cfg } = twoRepos();
    const db = freshDb();
    await queueBoth(db, a, b);
    const t3 = installFakeT3([a, b]);
    try {
      // cwd sits in A, the flag names B (by slug): the flag wins.
      const scope = resolveDrainScope(cfg, { repo: "B", cwd: a, home: "/nonexistent" });
      const r = await drainSpinoffs(db, "", {}, undefined, scope);
      expect(r.launched).toEqual(["B-1"]);
      expect(r.skipped_other_repo.map((s) => s.ticket)).toEqual(["A-1"]);
    } finally {
      t3.restore();
    }
  });

  test("a row queued with a slug is matched by the checkout it names, not by string equality", async () => {
    const { a, b, cfg } = twoRepos();
    const db = freshDb();
    await enqueueSpinoff(db, { ticketRef: "A-1", repo: "A", branch: "a-1", mode: "interactive", brief: "x", worktree: worktreePath(a, "a-1") });
    mkdirSync(worktreePath(a, "a-1"), { recursive: true });
    const t3 = installFakeT3([a, b]);
    try {
      // the scope comes from a PATH (the cwd), the row carries a SLUG; both name the same checkout
      const scope = resolveDrainScope(cfg, { cwd: a, home: "/nonexistent" });
      const r = await drainSpinoffs(db, "", {}, undefined, scope);
      expect(r.skipped_other_repo).toEqual([]);
      expect(r.launched.length + r.failed.length).toBe(1); // attempted: in scope
    } finally {
      t3.restore();
    }
  });

  test("--all launches both and prints how many were launched per repo", async () => {
    const { a, b, cfg } = twoRepos();
    const db = freshDb();
    await queueBoth(db, a, b);
    const t3 = installFakeT3([a, b]);
    try {
      const scope = resolveDrainScope(cfg, { all: true, cwd: "/nowhere", home: "/nonexistent" });
      const r = await drainSpinoffs(db, "", {}, undefined, scope);
      expect(r.launched).toEqual(["A-1", "B-1"]);
      expect(r.skipped_other_repo).toEqual([]);
      expect(r.scope).toBe("all");
      expect(r.by_repo).toEqual({ A: { launched: 1, failed: 0 }, B: { launched: 1, failed: 0 } });
      const text = renderDrainLines(r, { merged: [], blocked: [], mirrored: [], db_failures: [] } as never).join("\n");
      expect(text).toContain("A: launched 1");
      expect(text).toContain("B: launched 1");
    } finally {
      t3.restore();
    }
  });

  test("--all still counts a row whose checkout is not on this machine", async () => {
    const { a, cfg } = twoRepos();
    const db = freshDb();
    await enqueueSpinoff(db, { ticketRef: "G-1", repo: "ghost", branch: "g-1", mode: "interactive", brief: "x" });
    const t3 = installFakeT3([a]);
    try {
      const scope = resolveDrainScope(cfg, { all: true, cwd: "/nowhere", home: "/nonexistent" });
      const r = await drainSpinoffs(db, "", {}, undefined, scope);
      expect(r.by_repo.ghost).toEqual({ launched: 0, failed: 1 });
    } finally {
      t3.restore();
    }
  });

  test("run outside any resolvable repo, the scope refuses by name and falls back to nothing", () => {
    const { cfg } = twoRepos();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ob-drain-outside-")));
    bases.push(outside);
    expect(() => resolveDrainScope(cfg, { cwd: outside, home: "/nonexistent" })).toThrow(/spinoff drain launched nothing.*--all/s);
    expect(() => resolveDrainScope(cfg, { all: true, repo: "A", cwd: outside })).toThrow(/not both/);
    expect(() => resolveDrainScope(cfg, { repo: "ghost", cwd: outside, home: "/nonexistent" })).toThrow(/launched nothing/);
  });

  test("a checkout with no repo_checkouts entry and outside ~/dev still scopes by its path", () => {
    const { a } = twoRepos();
    const scope = resolveDrainScope({ repoCheckouts: {} }, { cwd: a, home: "/nonexistent" });
    expect(scope.kind === "repo" && scope.target).toBe(a);
  });
});

describe("OB-1796 drain scope: through the CLI", () => {
  const inDir = async (dir: string, dbPath: string, args: string[]) => {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      return await runCli(dbPath, args);
    } finally {
      process.chdir(prev);
    }
  };

  test("outside any repo `ob spinoff drain` exits non-zero, names the reason and launches nothing", async () => {
    const { a, b, cfg } = twoRepos();
    const dbPath = freshDbPath();
    const seed = openDb(dbPath);
    await setConfig(seed, "repo_checkouts", JSON.stringify(cfg.repoCheckouts));
    await queueBoth(seed, a, b);
    seed.close();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ob-drain-outside-")));
    bases.push(outside);
    const t3 = installFakeT3([a, b]);
    try {
      const r = await inDir(outside, dbPath, ["spinoff", "drain"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("spinoff drain launched nothing");
      expect(r.err).toContain("--all");
      expect(t3.launches).toHaveLength(0);
      expect((await listSpinoffs(openDb(dbPath), "pending")).length).toBe(2);
    } finally {
      t3.restore();
    }
  });

  test("in repo A `ob spinoff drain` launches only A, and `--all` launches the rest", async () => {
    const { a, b, cfg } = twoRepos();
    const dbPath = freshDbPath();
    const seed = openDb(dbPath);
    await setConfig(seed, "repo_checkouts", JSON.stringify(cfg.repoCheckouts));
    await queueBoth(seed, a, b);
    seed.close();
    const t3 = installFakeT3([a, b]);
    try {
      const first = await inDir(a, dbPath, ["spinoff", "drain"]);
      expect(first.code).toBe(0);
      expect(first.out).toContain("launched 1");
      expect(first.out).toContain("B-1: skipped");
      expect((await listSpinoffs(openDb(dbPath), "pending")).map((s) => s.ticket_ref)).toEqual(["B-1"]);

      const second = await inDir(a, dbPath, ["spinoff", "drain", "--all"]);
      expect(second.code).toBe(0);
      expect(second.out).toContain("B: launched 1");
      expect((await listSpinoffs(openDb(dbPath), "pending")).length).toBe(0);
    } finally {
      t3.restore();
    }
  });
});

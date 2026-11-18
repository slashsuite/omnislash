// OB-2180: reconcile landed row 2022 (OB-2173) at 11:22 on 2026-11-15, before its PR merged.
//
// The shape, reproduced here against a real git repo: the dispatch recorded base_sha b0da00b7 while
// origin/main was already two commits on (f9c1a85c). The builder's first act was `git rebase origin/main`,
// which fast-forwarded its still-empty branch onto f9c1a85c. Then `rev-list --count b0da00b7..ob-2173`
// said 2 (main's own commits) and `git branch --merged` said yes (the branch was a point on main), so
// `branchDone` fired with no builder work at all. No commit named the ticket and the ticket was open, so
// neither of the other signals was involved.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { enqueueSpinoff, gitUniqueCommitCount, listSpinoffs, reconcileSpinoffs } from "../src/commands/spinoff.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(repo: string, msg: string): string {
  writeFileSync(join(repo, "f.txt"), `${msg}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** main: base → c1 → c2. Returns the repo and base. No origin, so main is the ref measured against. */
function repoWithMainPastBase(): { repo: string; base: string } {
  const repo = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob2180-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  const base = commit(repo, "feat(OB-2169): the commit the dispatch recorded as base");
  commit(repo, "docs(skill): main moved on");
  commit(repo, "fix(OB-2140): main moved on again");
  return { repo, base };
}

async function seedRow(repo: string, branch: string, base: string) {
  const db = freshDb();
  const { row } = await enqueueSpinoff(db, { ticketRef: "OB-2173", repo, branch, mode: "interactive", brief: "b" });
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, base_sha = ? WHERE id = ?").run(branch, base, row.id);
  return db;
}

describe("reconcile and a branch that only picked up main's commits (OB-2180)", () => {
  test("an empty branch rebased onto a later main is NOT landed (row 2022)", async () => {
    const { repo, base } = repoWithMainPastBase();
    // the branch is created at the stale base, then the builder's `git rebase origin/main` moves it onto main
    git(repo, "branch", "ob-2173", base);
    git(repo, "checkout", "-q", "ob-2173");
    git(repo, "rebase", "-q", "main");
    git(repo, "checkout", "-q", "main");
    expect(gitUniqueCommitCount()(repo, base, "ob-2173")).toBe(0);
    const db = await seedRow(repo, "ob-2173", base);
    const rec = await reconcileSpinoffs(db);
    expect(rec.merged).toEqual([]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["OB-2173"]);
  });

  test("a branch whose own commit was fast-forwarded onto main IS landed (a local-only repo's land)", async () => {
    const { repo, base } = repoWithMainPastBase();
    git(repo, "checkout", "-q", "-b", "ob-2173");
    commit(repo, "feat(OB-2173): the builder's work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--ff-only", "ob-2173");
    expect(gitUniqueCommitCount()(repo, base, "ob-2173")).toBe(3);
    const db = await seedRow(repo, "ob-2173", base);
    expect((await reconcileSpinoffs(db)).merged).toEqual(["OB-2173"]);
  });

  test("a branch whose only commit is a merge it made, fast-forwarded onto main, IS landed", async () => {
    const { repo, base } = repoWithMainPastBase();
    git(repo, "checkout", "-q", "-b", "contrib", base);
    writeFileSync(join(repo, "contrib.txt"), "c\n"); // its own file, so the merges do not conflict
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a contributor's commit");
    git(repo, "checkout", "-q", "-b", "ob-2173", base);
    git(repo, "merge", "-q", "--no-ff", "-m", "merge the contributor", "contrib");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "bring main up", "ob-2173");
    git(repo, "checkout", "-q", "ob-2173");
    git(repo, "merge", "-q", "--ff-only", "main"); // the branch now sits on main's first-parent line
    git(repo, "checkout", "-q", "main");
    expect(gitUniqueCommitCount()(repo, base, "ob-2173")).toBeGreaterThan(0);
    const db = await seedRow(repo, "ob-2173", base);
    expect((await reconcileSpinoffs(db)).merged).toEqual(["OB-2173"]);
  });

  test("a branch whose own commit merged with a merge commit IS landed (its tip is off main's first-parent line)", async () => {
    const { repo, base } = repoWithMainPastBase();
    git(repo, "checkout", "-q", "-b", "ob-2173");
    commit(repo, "feat(OB-2173): the builder's work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge ob-2173", "ob-2173");
    expect(gitUniqueCommitCount()(repo, base, "ob-2173")).toBe(3);
    const db = await seedRow(repo, "ob-2173", base);
    expect((await reconcileSpinoffs(db)).merged).toEqual(["OB-2173"]);
  });
});

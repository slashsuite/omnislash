import { afterEach, describe, expect, test } from "bun:test";
import { runCli, freshDbPath, fakeRepoDir } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import {
  issueLabels,
  parseIssueRef,
  deriveBranch,
  splitRepo,
  __setCreateIssue,
  __setFetchIssue,
  type CreateIssueInput,
  type CreatedIssue,
} from "../../../apps/cli/src/github-issues.ts";
import { getItem, getLinearRef } from "../../../apps/cli/src/items.ts";
import { resolveIssueRef } from "../../cli-coord/src/commands/spinoff.ts";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";

describe("github-issues pure helpers (221 phase 3)", () => {
  test("issueLabels: wayfinder:task always; map:/exec: only when given", async () => {
    expect(issueLabels({})).toEqual(["wayfinder:task"]);
    expect(issueLabels({ map: "monorepo" })).toEqual(["wayfinder:task", "map:monorepo"]);
    expect(issueLabels({ exec: "agent" })).toEqual(["wayfinder:task", "exec:agent"]);
    expect(issueLabels({ map: "ui", exec: "interactive" })).toEqual([
      "wayfinder:task",
      "map:ui",
      "exec:interactive",
    ]);
    expect(issueLabels({ map: null, exec: null })).toEqual(["wayfinder:task"]);
  });

  test("parseIssueRef: only the explicit #<n> form → number; bare/other → null", async () => {
    expect(parseIssueRef("#35")).toBe(35);
    expect(parseIssueRef("  #7 ")).toBe(7);
    expect(parseIssueRef("35")).toBeNull(); // bare number = existing ob/wayfinder path
    expect(parseIssueRef("CUE-1234")).toBeNull();
    expect(parseIssueRef("#")).toBeNull();
    expect(parseIssueRef("#35a")).toBeNull();
  });

  test("deriveBranch: <n>-<slug>, truncated; empty title → just the number", async () => {
    expect(deriveBranch(35, "ob add --issue support")).toBe("35-ob-add-issue-support");
    expect(deriveBranch(35, "")).toBe("35");
    expect(deriveBranch(35, "!!!")).toBe("35");
    expect(deriveBranch(9, "A Very Long Title That Exceeds The Maximum Slug Length Allowed Here")).toBe(
      "9-a-very-long-title-that-exceeds-the-maxim",
    );
  });

  test("splitRepo: owner/name, else AppError", async () => {
    expect(splitRepo("owner/acme")).toEqual({ owner: "owner", name: "acme" });
    expect(() => splitRepo("acme")).toThrow(AppError);
    expect(() => splitRepo("a/b/c")).toThrow(AppError);
  });
});

describe("ob add --issue (mirror + GitHub issue via injected client)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("creates the issue with the right labels, mirrors it locally, links to the issue URL", async () => {
    const captured: CreateIssueInput[] = [];
    restore = __setCreateIssue(async (_db, input): Promise<CreatedIssue> => {
      captured.push(input);
      return { number: 42, url: "https://github.com/owner/acme/issues/42" };
    });
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, [
      "add",
      "wire the frobnicator",
      "--issue",
      "--map",
      "monorepo",
      "--exec",
      "agent",
      "--repo",
      "acme",
      "--kind",
      "side",
      "--body",
      "do the thing",
      "--json",
    ]);
    expect(r.code).toBe(0);
    // the issue create got title + body + the composed labels on wayfinder_repo (default)
    expect(captured).toHaveLength(1);
    expect(captured[0]!.title).toBe("wire the frobnicator");
    expect(captured[0]!.body).toBe("do the thing");
    expect(captured[0]!.repo).toBe("owner/acme");
    expect(captured[0]!.labels).toEqual(["wayfinder:task", "map:monorepo", "exec:agent"]);
    // output carries the local id + the issue number/url
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ issue: 42, url: "https://github.com/owner/acme/issues/42" });
    // the local mirror exists and links to the issue
    const db = openDb(dbPath);
    const item = await getItem(db, out.id);
    expect(item).not.toBeNull();
    expect(item!.type).toBe("task");
    expect(item!.title).toBe("wire the frobnicator");
    expect((await getLinearRef(db, out.id))!.url).toBe("https://github.com/owner/acme/issues/42");
  });

  test("without --issue, no issue is created (default unchanged) and no link is set", async () => {
    let called = false;
    restore = __setCreateIssue(async () => {
      called = true;
      return { number: 1, url: "x" };
    });
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["add", "plain local task", "--repo", "acme", "--kind", "side", "--json"]);
    expect(r.code).toBe(0);
    expect(called).toBe(false);
    const out = JSON.parse(r.out);
    expect(out.issue).toBeUndefined();
    const db = openDb(dbPath);
    expect(await getLinearRef(db, out.id)).toBeNull();
  });
});

describe("ob spinoff #<issue> ref resolution (via injected fetch)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("resolveIssueRef: #<n> → fetched title/body head + derived branch; other refs → null", async () => {
    restore = __setFetchIssue(async (_db, repo, number) => {
      expect(repo).toBe("owner/acme");
      return {
        number,
        title: "Add issue support",
        body: "Acceptance: it works.",
        url: `https://github.com/x/issues/${number}`,
      };
    });
    const db = freshDb();
    const resolved = await resolveIssueRef(db, "#35");
    expect(resolved).not.toBeNull();
    expect(resolved!.ticketRef).toBe("#35");
    expect(resolved!.branch).toBe("35-add-issue-support");
    expect(resolved!.head).toContain("GitHub issue #35: Add issue support");
    expect(resolved!.head).toContain("Acceptance: it works.");
    // a bare / non-# ref is not an issue ref
    expect(await resolveIssueRef(db, "154")).toBeNull();
    expect(await resolveIssueRef(db, "CUE-1")).toBeNull();
  });

  test("enqueue: #<n> stores ticket_ref #n, derived branch, brief seeded from the issue", async () => {
    restore = __setFetchIssue(async (_db, _repo, number) => ({
      number,
      title: "Make it faster",
      body: "profile first",
      url: `https://github.com/x/issues/${number}`,
    }));
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "#35", "--repo", fakeRepoDir(), "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ticket: "#35", status: "queued" });
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out);
    expect(rows[0].ticket_ref).toBe("#35");
    expect(rows[0].branch).toBe("35-make-it-faster");
    expect(rows[0].brief).toContain("Make it faster");
    expect(rows[0].brief).toContain("profile first");
    expect(rows[0].brief).not.toContain("Operating procedure");
  });

  test("spinoff brief #<n> composes the issue-seeded brief without launching", async () => {
    restore = __setFetchIssue(async (_db, _repo, number) => ({
      number,
      title: "Doc the thing",
      body: "write README",
      url: "u",
    }));
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["spinoff", "brief", "#7", "--repo", fakeRepoDir()]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("GitHub issue #7: Doc the thing");
    expect(r.out).toContain("write README");
    expect(r.out).not.toContain("Operating procedure");
    // dry-run — nothing queued
    expect(JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out)).toHaveLength(0);
  });

  test("a bare-number ref still works verbatim (existing path, no fetch)", async () => {
    let called = false;
    restore = __setFetchIssue(async () => {
      called = true;
      return { number: 0, title: "", body: null, url: "" };
    });
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "154", "--repo", fakeRepoDir(), "--json"]);
    expect(r.code).toBe(0);
    expect(called).toBe(false); // bare number never triggers a GitHub fetch
    expect(JSON.parse(r.out)).toMatchObject({ ticket: "154" });
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeFrontier,
  findWayfinderDir,
  parseBlockedBy,
  readFrontier,
  toTicket,
  type GithubIssue,
  type IssueFetcher,
} from "../../../apps/cli/src/wayfinder.ts";
import { freshDb } from "../../../apps/cli/test/helpers.ts";

// Build a raw GitHub issue as the fetch seam would yield it.
function issue(p: Partial<GithubIssue> & { number: number }): GithubIssue {
  return {
    number: p.number,
    title: p.title ?? `Ticket ${p.number}`,
    state: p.state ?? "OPEN",
    assignees: p.assignees ?? [],
    labels: p.labels ?? ["wayfinder:task"],
    body: p.body ?? null,
    url: p.url ?? `https://github.com/owner/acme/issues/${p.number}`,
  };
}

// A wayfinder dir near cwd so readFrontier proceeds to the (injected) fetch.
function scaffoldMapDir(): string {
  const root = mkdtempSync(join(tmpdir(), "wf-"));
  mkdirSync(join(root, "wayfinder"), { recursive: true });
  return root;
}

describe("wayfinder frontier reader (221)", () => {
  test("parseBlockedBy reads one or many #N from a `Blocked by` line", () => {
    expect(parseBlockedBy(null)).toEqual([]);
    expect(parseBlockedBy("no blockers here")).toEqual([]);
    expect(parseBlockedBy("Blocked by #18")).toEqual([18]);
    expect(parseBlockedBy("intro\nBlocked by #18 #17 #20\nmore")).toEqual([18, 17, 20]);
    expect(parseBlockedBy("blocked by: #5, #6")).toEqual([5, 6]); // case + punctuation tolerant
  });

  test("toTicket maps issue → ticket shape (number, state, assignee, blocked_by, url)", () => {
    const t = toTicket(
      issue({ number: 59, state: "OPEN", assignees: ["alex-example"], body: "Blocked by #58", url: "u/59" }),
    );
    expect(t).toEqual({
      id: 59,
      title: "Ticket 59",
      status: "open",
      assignee: "alex-example",
      blocked_by: [58],
      url: "u/59",
    });
    expect(toTicket(issue({ number: 1, state: "CLOSED" })).status).toBe("closed");
    expect(toTicket(issue({ number: 2, assignees: [] })).assignee).toBeNull();
  });

  test("computeFrontier: takeable = open + unassigned + all blockers closed; blocked = the rest", () => {
    const tickets = [
      issue({ number: 58, state: "CLOSED" }),
      issue({ number: 59, state: "OPEN", body: "Blocked by #58" }), // blocker closed → takeable
      issue({ number: 60, state: "OPEN" }), // unblocked → takeable
      issue({ number: 61, state: "OPEN", body: "Blocked by #60" }), // blocker still open → blocked
      issue({ number: 62, state: "OPEN", assignees: ["alex-example"] }), // claimed → not takeable
      issue({ number: 57, state: "CLOSED" }), // done → not in frontier
      issue({ number: 5, state: "OPEN", labels: ["wayfinder:epic"] }), // an epic, no blockers → takeable
    ].map(toTicket);
    const { takeable, blocked } = computeFrontier(tickets);
    expect(takeable.map((t) => t.id)).toEqual([5, 59, 60]); // sorted ascending by number
    expect(blocked).toBe(2); // 61 (blocked) + 62 (claimed)
  });

  test("readFrontier: no wayfinder dir near cwd → null (no fetch)", async () => {
    let called = false;
    const fetcher: IssueFetcher = async () => {
      called = true;
      return [];
    };
    const noMap = mkdtempSync(join(tmpdir(), "nomap-"));
    expect(await readFrontier(freshDb(), noMap, fetcher)).toBeNull();
    expect(called).toBe(false);
  });

  test("readFrontier: composes the frontier from the injected issue list", async () => {
    const root = scaffoldMapDir();
    const fetcher: IssueFetcher = async () => [
      issue({ number: 58, state: "CLOSED" }),
      issue({ number: 59, state: "OPEN", body: "Blocked by #58" }),
      issue({ number: 61, state: "OPEN", body: "Blocked by #60", labels: ["wayfinder:epic"] }),
      issue({ number: 60, state: "OPEN" }),
    ];
    const view = await readFrontier(freshDb(), root, fetcher);
    expect(view).not.toBeNull();
    expect(view!.dir).toBe(join(root, "wayfinder"));
    expect(view!.takeable.map((t) => t.id)).toEqual([59, 60]);
    expect(view!.blocked).toBe(1); // 61 still blocked by open #60
  });

  test("readFrontier: any fetch/network error degrades to null (never throws)", async () => {
    const root = scaffoldMapDir();
    const boom: IssueFetcher = async () => {
      throw new Error("network down");
    };
    expect(await readFrontier(freshDb(), root, boom)).toBeNull();
  });

  test("findWayfinderDir walks up to the nearest wayfinder/ dir", () => {
    const root = scaffoldMapDir();
    expect(findWayfinderDir(join(root, "some", "nested"))).toBe(join(root, "wayfinder"));
    expect(findWayfinderDir(mkdtempSync(join(tmpdir(), "none-")))).toBeNull();
  });
});

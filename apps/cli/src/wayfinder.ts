import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { githubGql, readGithubToken } from "./net.ts";
import { settingFor } from "./settings.ts";
import { asStore, type Store } from "./db/store.ts";

// Surface the wayfinder "frontier" (takeable tickets) in `ob status` (060/221). Tickets now live as
// GitHub issues labelled `wayfinder:task`/`wayfinder:epic` (decision #27) — the maps stay markdown in
// `wayfinder/`, only the TICKET/frontier source is GitHub. Kept isolated so ob never hard-depends on
// wayfinder: callers get null when there is no `wayfinder/` dir near cwd OR on any fetch/auth/network
// error, and the status snapshot just omits the section.

export interface WayfinderTicket {
  id: number; // the GitHub issue number
  title: string;
  status: string; // "open" | "closed" (issue state, lowercased)
  assignee: string | null; // the GitHub login of the (first) assignee, or null when unclaimed
  blocked_by: number[]; // issue numbers parsed from a `Blocked by #N` line in the body
  url: string; // the issue URL
}

export interface FrontierView {
  dir: string;
  takeable: WayfinderTicket[]; // open, unassigned, every blocker closed — ordered by id
  blocked: number; // other open tickets (blocked or claimed)
}

/** The raw issue shape the fetch seam yields — the minimum the frontier needs. */
export interface GithubIssue {
  number: number;
  title: string;
  state: string; // "OPEN" | "CLOSED"
  assignees: string[]; // logins
  labels: string[]; // names
  body: string | null;
  url: string;
}

/** Fetch seam (test injection point): given a repo, yield its wayfinder issues (open + closed). */
export type IssueFetcher = (db: Database | Store, repo: string) => Promise<GithubIssue[]>;

/**
 * Why the LIVE frontier fetch cannot run under OMNISLASH_STORE=postgres (337).
 *
 * The frontier needs a GitHub token, and the token comes from the encrypted credential store through
 * net.ts, which is not ported. Every other failure in this file degrades to null and the section simply
 * vanishes from `ob status` -- which is right for a network blip and WRONG for a cutover, because a
 * silently missing section reads exactly like an empty frontier. So this one is named: `ob status` prints
 * the reason where the section would have been.
 */
export const FRONTIER_UNDER_POSTGRES =
  "frontier unavailable: the GitHub token path is not ported to the store seam yet (ob 337). run with OMNISLASH_STORE=sqlite to see it.";

/** Nearest ancestor of `start` containing a `wayfinder/` dir (where the maps live), or null. */
export function findWayfinderDir(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "wayfinder"))) return join(dir, "wayfinder");
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parse blocker issue numbers from `Blocked by #N` lines in an issue body (may list several). Pure. */
export function parseBlockedBy(body: string | null | undefined): number[] {
  if (!body) return [];
  const out: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*blocked\s+by\b\s*:?\s*(.*)$/i);
    if (!m) continue;
    for (const hit of m[1]!.match(/#(\d+)/g) ?? []) out.push(Number(hit.slice(1)));
  }
  return out;
}

/** Map a raw GitHub issue onto the WayfinderTicket shape. Pure. */
export function toTicket(issue: GithubIssue): WayfinderTicket {
  return {
    id: issue.number,
    title: issue.title,
    status: issue.state.toUpperCase() === "CLOSED" ? "closed" : "open",
    assignee: issue.assignees[0] ?? null,
    blocked_by: parseBlockedBy(issue.body),
    url: issue.url,
  };
}

/** The frontier: open + unassigned + every blocker closed. Pure. */
export function computeFrontier(tickets: WayfinderTicket[]): { takeable: WayfinderTicket[]; blocked: number } {
  const closed = new Set(tickets.filter((t) => t.status === "closed").map((t) => t.id));
  const open = tickets.filter((t) => t.status === "open");
  const takeable = open
    .filter((t) => !t.assignee && t.blocked_by.every((b) => closed.has(b)))
    .sort((a, b) => a.id - b.id);
  return { takeable, blocked: open.length - takeable.length };
}

// --- live GitHub fetch ------------------------------------------------------

const ISSUES_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    nodes { ... on Issue {
      number title url state
      assignees(first: 10) { nodes { login } }
      labels(first: 20) { nodes { name } }
      body
    }}
    pageInfo { hasNextPage endCursor }
  }
}`;

interface IssueNode {
  number: number | null;
  title: string | null;
  url: string | null;
  state: string | null;
  assignees: { nodes: Array<{ login: string | null } | null> } | null;
  labels: { nodes: Array<{ name: string | null } | null> } | null;
  body: string | null;
}

interface IssueSearchResp {
  search: {
    nodes: Array<IssueNode | null>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * Live fetch: the repo's `wayfinder:task`/`wayfinder:epic` issues, BOTH open and closed (closed states
 * are needed to resolve blockers). GitHub search's `label:a,b` is OR, so one query covers both labels.
 * Exported so the tracker-drift surface (77) reuses this ONE query instead of writing a second one.
 */
export async function fetchIssuesLive(db: Database | Store, repo: string): Promise<GithubIssue[]> {
  const store = asStore(db);
  // 389: the token read is on the store seam (337 branch G). The old sqlite gate was leftover from
  // when net.ts was unported; it blocked `ob issue reconcile`/`drift` on the postgres API host.
  const token = await readGithubToken(store);
  const q = `repo:${repo} is:issue label:wayfinder:task,wayfinder:epic`;
  const out: GithubIssue[] = [];
  let after: string | null = null;
  do {
    const resp: IssueSearchResp = await githubGql<IssueSearchResp>(token, ISSUES_QUERY, { q, after });
    const page = resp.search;
    for (const n of page.nodes ?? []) {
      if (!n || n.number == null) continue;
      out.push({
        number: n.number,
        title: n.title ?? "",
        state: n.state ?? "OPEN",
        assignees: (n.assignees?.nodes ?? []).map((a) => a?.login).filter((l): l is string => !!l),
        labels: (n.labels?.nodes ?? []).map((l) => l?.name).filter((l): l is string => !!l),
        body: n.body ?? null,
        url: n.url ?? "",
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return out;
}

/**
 * The frontier of the nearest wayfinder map to `start`, or null when there is no map / the fetch fails.
 * Async: sources tickets from the `wayfinder_repo` GitHub issues (221). `fetchIssues` is injectable so
 * tests never hit the network. Never throws — any gql/network/auth/token error degrades to null.
 */
export async function readFrontier(
  db: Database | Store,
  start: string = process.cwd(),
  fetchIssues: IssueFetcher = fetchIssuesLive,
): Promise<FrontierView | null> {
  // Offline escape hatch (mirrors the OMNISLASH_DB test convention): when set, the frontier is skipped
  // entirely so the CLI never reaches out to GitHub. The e2e test harness sets it so command-path tests
  // (`ob status` runs from the repo, which has a `wayfinder/` dir) stay off the network; direct callers
  // that inject their own `fetchIssues` don't go through here with it set. Honoured only for the LIVE
  // fetcher — an explicitly injected fetcher (unit tests) is always used.
  if (process.env.OMNISLASH_DISABLE_FRONTIER && fetchIssues === fetchIssuesLive) return null;
  const dir = findWayfinderDir(start);
  if (!dir) return null;
  try {
    const repo = await settingFor(db, "wayfinder_repo");
    const tickets = (await fetchIssues(db, repo)).map(toTicket);
    const { takeable, blocked } = computeFrontier(tickets);
    return { dir, takeable, blocked };
  } catch {
    return null; // graceful degradation — status simply omits the frontier section
  }
}

import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { githubGql, readGithubToken } from "../net.ts";
import { recordEventFor } from "../events.ts";
import { getCursorFor, resolveSince, setCursorFor, settingFor } from "../settings.ts";
import { asStore, type Store } from "../db/store.ts";

const PRS_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    nodes { ... on PullRequest {
      number title url updatedAt
      repository { nameWithOwner }
      createdAt mergedAt closedAt isDraft
      additions deletions changedFiles
      headRefName baseRefName
      commits(first: 1) { nodes { commit { committedDate } } }
      timelineItems(first: 100, itemTypes: [
        READY_FOR_REVIEW_EVENT, PULL_REQUEST_REVIEW ]) {
        nodes { __typename
          ... on ReadyForReviewEvent { createdAt }
          ... on PullRequestReview { id author { __typename login } state submittedAt body }
        }
      }
      reviewThreads(first: 100) { nodes { comments(first: 50) {
        nodes { id author { __typename login } createdAt path body } } } }
    }}
    pageInfo { hasNextPage endCursor }
  }
}`;

interface TimelineNode {
  __typename: string;
  id?: string | null;
  createdAt?: string | null;
  author?: { __typename?: string | null; login: string | null } | null;
  state?: string | null;
  submittedAt?: string | null;
  body?: string | null;
}

interface CommentNode {
  id?: string | null;
  author: { __typename?: string | null; login: string | null } | null;
  createdAt: string | null;
  path?: string | null;
  body?: string | null;
}

interface PrNode {
  number: number | null;
  title: string | null;
  url: string | null;
  updatedAt: string | null;
  repository: { nameWithOwner: string | null } | null;
  createdAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  headRefName: string | null;
  baseRefName: string | null;
  commits: { nodes: Array<{ commit: { committedDate: string | null } | null } | null> } | null;
  timelineItems: { nodes: Array<TimelineNode | null> } | null;
  reviewThreads: {
    nodes: Array<{ comments: { nodes: Array<CommentNode | null> } | null } | null>;
  } | null;
}

interface SearchResp {
  search: {
    nodes: Array<PrNode | null>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// --- pure, unit-testable helpers -------------------------------------------

/** Branch age = (mergedAt − first commit) in days, or null if not merged / no commit. */
export function branchAgeDays(
  mergedAt: string | null | undefined,
  firstCommitDate: string | null | undefined,
): number | null {
  if (!mergedAt || !firstCommitDate) return null;
  const ms = new Date(mergedAt).getTime() - new Date(firstCommitDate).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms / 86400000) * 100) / 100;
}

/** Latest ReadyForReviewEvent timestamp, or null if the PR was never marked ready. */
export function latestReadyAt(nodes: Array<TimelineNode | null> | null | undefined): string | null {
  let latest: string | null = null;
  for (const n of nodes ?? []) {
    if (n?.__typename === "ReadyForReviewEvent" && n.createdAt) {
      if (latest === null || n.createdAt > latest) latest = n.createdAt;
    }
  }
  return latest;
}

/**
 * Window start for the comments-after-ready metric. Latest explicit ready event,
 * else the PR's creation time if it was born ready (not a draft), else null.
 */
export function readyWindowStart(
  nodes: Array<TimelineNode | null> | null | undefined,
  createdAt: string | null | undefined,
  isDraft: boolean | null | undefined,
): string | null {
  const explicit = latestReadyAt(nodes);
  if (explicit !== null) return explicit;
  if (!isDraft && createdAt) return createdAt;
  return null;
}

/** True when a review/comment landed after the ready window opened. */
export function afterReady(ts: string | null | undefined, readyAt: string | null): boolean {
  if (!ts || readyAt === null) return false;
  return ts > readyAt;
}

/** Exclude the PR author (self) and bot accounts from review/comment counts. */
export function isSelfOrBot(login: string | null | undefined, self: string): boolean {
  if (!login) return true;
  const l = login.toLowerCase();
  if (l === self.toLowerCase()) return true;
  if (l.endsWith("[bot]") || l.endsWith("-bot")) return true;
  return false;
}

/** True when the reviewer is the PR author themselves. */
export function isSelf(login: string | null | undefined, self: string): boolean {
  return !!login && login.toLowerCase() === self.toLowerCase();
}

/**
 * Detect bot reviewers. GitHub's GraphQL returns a bot's login without the `[bot]`
 * suffix (e.g. `coderabbitai`), so the login heuristic alone misses them — the
 * author's `__typename === "Bot"` is the reliable signal. Bot review events are
 * still recorded (raw truth) but tagged `bot: true` so the read-model excludes them.
 */
export function isBotAuthor(login: string | null | undefined, typename?: string | null): boolean {
  if (typename === "Bot") return true;
  const l = (login ?? "").toLowerCase();
  return l.endsWith("[bot]") || l.endsWith("-bot");
}

interface StoreCommentInput {
  id: string | null | undefined;
  pr: string;
  repo: string | null;
  author: string | null;
  kind: "review" | "line";
  path: string | null;
  state: string | null;
  body: string | null;
  afterReady: boolean;
  bot: boolean;
  createdAt: string | null;
}

/**
 * Persist a review/line comment body into `pr_comment` (+ FTS), idempotent on the
 * GitHub node id. Skips empty-body reviews (e.g. bare APPROVE with no text). Bodies
 * are stored raw (incl. bot comments, flagged) — the durable review corpus.
 */
async function storeComment(store: Store, c: StoreCommentInput): Promise<void> {
  if (!c.id || !c.body || c.body.trim().length === 0) return;
  // INSERT ... ON CONFLICT(id) DO NOTHING: only maintain FTS when a NEW row lands.
  // The insert reports no row-count, so check existence first (safe — the caller runs this in a txn).
  const existing = (await store.q
    .select({ id: store.t.prComment.id })
    .from(store.t.prComment)
    .where(eq(store.t.prComment.id, c.id))
    .limit(1)) as Array<{ id: string }>;
  if (existing.length > 0) return;
  // `after_ready` and `bot` are plain `integer` on BOTH engines (ob 321 kept them so), not
  // `{ mode: "boolean" }` columns, so the 0/1 here is the literal stored value on either side and there
  // is nothing for `store.bool` to encode.
  await store.q.insert(store.t.prComment).values({
    id: c.id,
    pr: c.pr,
    repo: c.repo,
    author: c.author,
    kind: c.kind,
    path: c.path,
    state: c.state,
    body: c.body,
    afterReady: c.afterReady ? 1 : 0,
    bot: c.bot ? 1 : 0,
    createdAt: c.createdAt,
  });
  // SQLITE ONLY: pr_comment_fts is a plain fts5 virtual table with no triggers, so SQLite maintains it
  // here by hand. On Postgres ob 322 declared `search_vec` GENERATED ALWAYS on pr_comment itself, so the
  // insert above already recomputed it and calling this would be an error, not a no-op.
  if (store.kind === "sqlite") {
    await store.q.run(sql`INSERT INTO pr_comment_fts(id, body) VALUES(${c.id}, ${c.body})`);
  }
}

// --- ingestion --------------------------------------------------------------

export async function syncGithub(
  db: Database | Store,
  opts: { since?: string; backfill?: boolean },
): Promise<{ prs: number; events: number; cursor: string | null }> {
  const store = asStore(db);
  const token = await readGithubToken(store);
  const login = await settingFor(store, "github_login");
  const since = await resolveSince(store, "github_prs_since", opts.since, opts.backfill ?? false);
  const sinceDate = since.slice(0, 10); // YYYY-MM-DD
  const q = `is:pr author:${login} updated:>=${sinceDate}`;

  let after: string | null = null;
  let prs = 0;
  let events = 0;
  let maxUpdated = (await getCursorFor(store, "github_prs_since")) ?? since;

  do {
    const resp: SearchResp = await githubGql<SearchResp>(token, PRS_QUERY, { q, after });
    const page = resp.search;
    for (const n of page.nodes ?? []) {
      if (!n || n.number == null || !n.repository?.nameWithOwner) continue;
      const pr = `${n.repository.nameWithOwner}#${n.number}`;
      prs++;
      if (n.updatedAt && n.updatedAt > maxUpdated) maxUpdated = n.updatedAt;

      const createdAt = n.createdAt;
      const firstCommit = n.commits?.nodes?.[0]?.commit?.committedDate ?? null;
      const readyExplicit = latestReadyAt(n.timelineItems?.nodes);
      const windowStart = readyWindowStart(n.timelineItems?.nodes, createdAt, n.isDraft);

      await store.txn("record the pull request", async (tx) => {
        // pr_synced — the canonical PR facts. ts = createdAt.
        if (createdAt) {
          await recordEventFor(tx, {
            ts: createdAt,
            source: "github",
            type: "pr_synced",
            payload: {
              pr,
              title: n.title ?? null,
              url: n.url ?? null,
              repo: n.repository!.nameWithOwner,
              head_ref: n.headRefName ?? null, // the branch (070/071)
              additions: n.additions ?? 0,
              deletions: n.deletions ?? 0,
              changed_files: n.changedFiles ?? 0,
              branch_age_days: branchAgeDays(n.mergedAt, firstCommit),
              created_at: createdAt,
              merged_at: n.mergedAt ?? null,
              closed_at: n.closedAt ?? null,
              is_draft: n.isDraft ?? false,
            },
          });
          events++;
        }

        // ready_for_review — the latest explicit ready event (window start for #1).
        if (readyExplicit) {
          await recordEventFor(tx, {
            ts: readyExplicit,
            source: "github",
            type: "ready_for_review",
            payload: { pr, ready_at: readyExplicit },
          });
          events++;
        }

        // review — PullRequestReview timeline items (exclude PENDING, self, bots).
        for (const t of n.timelineItems?.nodes ?? []) {
          if (!t || t.__typename !== "PullRequestReview") continue;
          if (!t.submittedAt) continue;
          if (t.state === "PENDING") continue;
          const author = t.author?.login ?? null;
          if (isSelf(author, login)) continue;
          const reviewBot = isBotAuthor(author, t.author?.__typename);
          const reviewAfterReady = afterReady(t.submittedAt, windowStart);
          await recordEventFor(tx, {
            ts: t.submittedAt,
            source: "github",
            type: "review",
            actor: author,
            payload: {
              pr,
              author,
              state: t.state ?? null,
              after_ready: reviewAfterReady,
              bot: reviewBot,
            },
          });
          events++;
          await storeComment(tx, {
            id: t.id,
            pr,
            repo: n.repository!.nameWithOwner,
            author,
            kind: "review",
            path: null,
            state: t.state ?? null,
            body: t.body ?? null,
            afterReady: reviewAfterReady,
            bot: reviewBot,
            createdAt: t.submittedAt,
          });
        }

        // review_comment — line comments on review threads (exclude self, bots).
        for (const thread of n.reviewThreads?.nodes ?? []) {
          for (const c of thread?.comments?.nodes ?? []) {
            if (!c || !c.createdAt) continue;
            const author = c.author?.login ?? null;
            if (isSelf(author, login)) continue;
            const commentBot = isBotAuthor(author, c.author?.__typename);
            const commentAfterReady = afterReady(c.createdAt, windowStart);
            await recordEventFor(tx, {
              ts: c.createdAt,
              source: "github",
              type: "review_comment",
              actor: author,
              payload: {
                pr,
                author,
                after_ready: commentAfterReady,
                bot: commentBot,
              },
            });
            events++;
            await storeComment(tx, {
              id: c.id,
              pr,
              repo: n.repository!.nameWithOwner,
              author,
              kind: "line",
              path: c.path ?? null,
              state: null,
              body: c.body ?? null,
              afterReady: commentAfterReady,
              bot: commentBot,
              createdAt: c.createdAt,
            });
          }
        }

        // note: `review_given` (reviews YOU gave on OTHERS' PRs, for review-throughput)
        // is NOT derivable here — this search is scoped to `author:<login>`, so it only
        // returns your own PRs and the reviews others left on them. Emitting it needs a
        // separate `reviewedBy:<login>`/contributions query; deferred.
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  await setCursorFor(store, "github_prs_since", maxUpdated);
  return { prs, events, cursor: maxUpdated };
}

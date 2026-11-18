// ob 337: `ob status` reads from Postgres (1121 removed the report/metrics half of this test with the
// measurement layer; the orderings below are status's own).
//
// These three commands are almost entirely AGGREGATES and ORDERED reads, which is exactly where this
// migration's silent differences live. So this test is not "does it throw" -- it seeds a realistic set of
// rows and asserts the VALUES and the TYPES that come back:
//
//   * ORDER BY ... DESC puts NULLs FIRST on Postgres and LAST on SQLite. Every ordering these reads use
//     was claimed to be on a NOT NULL column; the orderings are asserted here rather than reasoned about.
//     openItems is the interesting one: its lead expression is `today_rank is null`, which yields
//     booleans on Postgres and 0/1 on SQLite, and ASC has to put the RANKED items first either way.
//   * a discarded promise is invisible to typecheck, so every value below is awaited through the real
//     command-level entry points rather than through the leaf queries.
//
// It uses the ob 325 harness: a real local cluster over a unix socket. No network, and never the live
// database (the database host) -- OMNISLASH_PG_URL cannot address a unix socket, so the store is opened with the
// harness's own connection options, the way pg-cli-coord-337.test.ts does.
import { describe, expect, test } from "bun:test";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { buildStatus, inFlightPrsFor } from "../../../apps/cli/src/commands/status.ts";

const PG_BUDGET = spawnBudget(3);


/** One `pr_synced` payload as the GitHub sync writes it. */
function prSynced(p: Record<string, unknown>): string {
  return JSON.stringify(p);
}

/**
 * A realistic slice of the tracker: open/blocked/ranked
 * items; a closed item inside the window; a PR that has been re-synced (so "latest facts win" is
 * exercised); a human after-ready comment; and the events every metric is derived from.
 */
async function seed(s: Store): Promise<void> {
  const t = s.t;

  await s.q.insert(t.spinoff).values([
    { ticket_ref: "#1", repo: "/r", branch: "b1", worktree: "/w/1", brief: "one", mode: "agent", status: "launched", request_at: "2026-07-03T00:00:00.000Z" },
    { ticket_ref: "#2", repo: "/r", branch: "b2", worktree: "/w/2", brief: "two", mode: "agent", status: "merged", request_at: "2026-07-04T00:00:00.000Z" },
  ]);

  await s.q.insert(t.item).values([
    { id: "itm-rank1", type: "task", title: "ranked first", status: "open", today_rank: 1, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" },
    { id: "itm-rank2", type: "task", title: "ranked second", status: "open", today_rank: 2, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z" },
    // Same updated_at as each other: `id` ASC is the only thing that can order them.
    { id: "itm-a", type: "task", title: "unranked a", status: "open", created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-09T00:00:00.000Z" },
    { id: "itm-b", type: "task", title: "unranked b", status: "blocked", block_reason: "waiting on review", block_owner: "someone", created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-09T00:00:00.000Z" },
    { id: "itm-done", type: "task", title: "closed in window", status: "done", closed_at: "2026-07-15T00:00:00.000Z", created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-15T00:00:00.000Z" },
  ]);

  await s.q.insert(t.person).values({
    real_name: "Sam Sample",
    github_login: "sam-gh",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  });

  await s.q.insert(t.prComment).values([
    { id: "c1", pr: "o/r#7", author: "sam-gh", afterReady: 1, bot: 0, createdAt: "2026-07-12T00:00:00.000Z" },
    { id: "c2", pr: "o/r#8", author: "coderabbitai", afterReady: 1, bot: 1, createdAt: "2026-07-12T00:00:00.000Z" },
  ]);

  await s.q.insert(t.event).values([
    // #7 is re-synced: the LATER row (higher id) must win, and both rows carry the same ts, which is
    // precisely why the ordering is on id rather than ts.
    { ts: "2026-07-11T00:00:00.000Z", source: "github", type: "pr_synced", payload: prSynced({ pr: "o/r#7", title: "cue-42 first sync", head_ref: "feat/cue-42", additions: 1, deletions: 1, is_draft: true, branch_age_days: 1 }) },
    { ts: "2026-07-11T00:00:00.000Z", source: "github", type: "pr_synced", payload: prSynced({ pr: "o/r#7", title: "cue-42 resynced", head_ref: "feat/cue-42", additions: 10, deletions: 4, is_draft: false, branch_age_days: 3 }) },
    { ts: "2026-07-11T00:00:00.000Z", source: "github", type: "pr_synced", payload: prSynced({ pr: "o/r#8", title: "no ticket here", additions: 2, deletions: 2, branch_age_days: 9 }) },
    { ts: "2026-07-11T00:00:00.000Z", source: "github", type: "pr_synced", payload: prSynced({ pr: "o/r#9", title: "merged already", merged_at: "2026-07-12T00:00:00.000Z", additions: 3, deletions: 3 }) },
    // the other ingested streams (background rows for the status reads below)
    { ts: "2026-07-12T00:00:00.000Z", source: "github", type: "ticket_completed", payload: JSON.stringify({ entity: "CUE-42", estimate: 2, duration_h: 10 }) },
    { ts: "2026-07-13T00:00:00.000Z", source: "github", type: "ticket_completed", payload: JSON.stringify({ entity: "CUE-43", estimate: 2, duration_h: 20 }) },
    { ts: "2026-07-14T00:00:00.000Z", source: "github", type: "reopened", payload: JSON.stringify({ entity: "CUE-43" }) },
    { ts: "2026-07-14T00:00:00.000Z", source: "github", type: "review", payload: JSON.stringify({ pr: "o/r#7", author: "sam-gh", after_ready: true }) },
    { ts: "2026-07-14T00:00:00.000Z", source: "github", type: "review_comment", payload: JSON.stringify({ pr: "o/r#7", author: "coderabbitai", after_ready: true }) },
    { ts: "2026-07-14T00:00:00.000Z", source: "github", type: "review_given", payload: JSON.stringify({ pr: "o/r#99" }) },
    { ts: "2026-07-14T00:00:00.000Z", source: "github", type: "state_change", cause: "bug", payload: JSON.stringify({ qa_rework: true }) },
    // the standup journal
    { ts: "2026-07-16T00:00:00.000Z", source: "journal", type: "kudos", actor: "me", payload: JSON.stringify({ text: "nice review", about: "sam-gh" }) },
  ]);
}

describe("ob status reads correctly from Postgres (337)", () => {
  test(
    "the aggregates, the orderings and the derived values are right on Postgres",
    async () => {
      const lease = await leaseRealPgDb();
      let store: Store | undefined;
      try {
        store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        expect(store.kind).toBe("postgres");
        expect(store.sqlite).toBeNull();
        await seed(store);

        // --- inFlightPrs: "latest facts win" is decided by event.id --------------------------------
        const prs = await inFlightPrsFor(store);
        expect(prs.map((p) => p.pr).sort()).toEqual(["o/r#7", "o/r#8"]); // #9 is merged, so not in flight
        const seven = prs.find((p) => p.pr === "o/r#7")!;
        // The RE-SYNC won: draft -> not draft, 1/1 -> 10/4. The first row's facts would have said
        // "authoring", and both rows carry the same ts, so only the id ordering can tell them apart.
        expect(seven.title).toBe("cue-42 resynced");
        expect(seven.additions).toBe(10);
        expect(seven.deletions).toBe(4);
        expect(seven.state).toBe("addressing-comments"); // not draft + a human after-ready comment
        // #8's only after-ready comment is a BOT's, so it is still waiting for review.
        expect(prs.find((p) => p.pr === "o/r#8")!.state).toBe("waiting-review");

        // --- buildStatus: the whole snapshot ------------------------------------------------------
        const snap = await buildStatus(store);
        // openItems: ranked first (the `today_rank is null` expression sorts booleans on Postgres),
        // then rank ASC, then updated_at DESC, then the id tiebreak between itm-a and itm-b.
        expect(snap.focus.map((i) => i.id)).toEqual(["itm-rank1", "itm-rank2"]);
        expect(snap.blocked.map((i) => i.id)).toEqual(["itm-b"]);
        expect(snap.blocked[0]!.block_reason).toBe("waiting on review");
        expect(snap.completed_spinoffs.map((r) => r.ticket_ref)).toEqual(["#2"]);
        // The frontier cannot be read under Postgres (its token path is unported), and the point of
        // ob 337's treatment is that it says so instead of looking like an EMPTY frontier.
        expect(snap.frontier).toBeNull();
        expect(snap.frontier_note).toContain("not ported");
        // buildStatus's journal is a fixed last-24h window and the seeded entry is older, so this is the
        // EMPTY case.
        expect(snap.journal).toEqual([]);

      } finally {
        await store?.close();
        await lease.release();
      }
    },
    PG_BUDGET,
  );
});

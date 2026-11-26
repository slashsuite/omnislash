import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, ne, not, sql } from "drizzle-orm";
import type { Ctx } from "../ctx.ts";
import { orm } from "../db/orm.ts";
import { event, prComment } from "../db/schema.ts";
import { triageCount } from "../items.ts";
import { triageBanner } from "./triage.ts";
import { print } from "../output.ts";
import { asStore, type Store } from "../db/store.ts";
import { agentStateLabel, listAgents, type AgentStatusRow } from "../../../../platform/cli-coord/src/agent.ts";
import { FRONTIER_UNDER_POSTGRES, readFrontier, type FrontierView, type IssueFetcher } from "../wayfinder.ts";
import { listJournal, orderJournal } from "./log.ts";
import { resolvePersonFor } from "./person.ts";
import { recentlyDoneSpinoffs, type SpinoffRow } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { priorityName } from "../priority.ts";
import { NON_QUEUE_TYPES } from "../status.ts";
import { listDeploys, notOkLiveDeploy, type DeployRow } from "./deploy.ts";
import { readT3View, renderT3ThreadsBlock, storeT3RowSource, type T3ReadView, type T3RowSource } from "../t3/read.ts";

// ob status (046): a NOW snapshot — agents · in-flight PRs by state · blocked · live deploy (when not ok) · focus · recent journal.

interface OpenItem {
  id: string;
  ref: string | null; // 1949: `PS-12`, what the status board prints; null for a keyless project's item
  title: string;
  status: string;
  priority: string | null; // human name (urgent|flake|high|medium|low), or null when unset — drives the UI priority pill (QW1)
  block_reason: string | null;
  block_owner: string | null;
  today_rank: number | null;
}

/**
 * Every not-done item, ranked-first (337: store-aware).
 *
 * The ordering was checked column by column rather than assumed, because DESC puts NULLs FIRST on
 * Postgres and LAST on SQLite:
 *   `today_rank is null`  -- an EXPRESSION, not a column, and it agrees on both engines: SQLite yields
 *                            0/1 and Postgres false/true, and ASC puts 0 and false first either way, so
 *                            the ranked items lead on both.
 *   `today_rank` ASC      -- reached only within one side of that split, so every value in the group is
 *                            non-null (or every value is null) and the NULLS difference cannot bite.
 *   `updated_at` DESC     -- NOT NULL on both engines (db/schema.ts and db/pg/schema.ts).
 *   `id` ASC              -- the tiebreak. `updated_at` is an ISO string written by nowIso(), so two
 *                            items touched in the same millisecond otherwise fall wherever the plan put
 *                            them: rowid-ish on SQLite, arbitrary on Postgres.
 */
export async function openItemsFor(db: Database | Store): Promise<OpenItem[]> {
  const s = asStore(db);
  const rows = (await s.q
    .select({
      id: s.t.item.id,
      ref: s.t.item.ref,
      title: s.t.item.title,
      status: s.t.item.status,
      priority: s.t.item.priority,
      block_reason: s.t.item.block_reason,
      block_owner: s.t.item.block_owner,
      today_rank: s.t.item.today_rank,
    })
    .from(s.t.item)
    // OB-2004: a reference document is not work, so it is never in focus or blocked, whatever its rank.
    .where(and(ne(s.t.item.status, "done"), not(inArray(s.t.item.type, NON_QUEUE_TYPES))))
    .orderBy(
      sql`${s.t.item.today_rank} is null`,
      asc(s.t.item.today_rank),
      desc(s.t.item.updated_at),
      asc(s.t.item.id),
    )) as Array<Omit<OpenItem, "priority"> & { priority: number | null }>;
  return rows.map((r) => ({ ...r, priority: r.priority !== null ? priorityName(r.priority) : null }));
}

export type PrState = "authoring" | "waiting-review" | "addressing-comments";

export interface InFlightPr {
  pr: string;
  title: string | null;
  url: string | null;
  repo: string | null;
  additions: number;
  deletions: number;
  branch_age_days: number | null;
  state: PrState;
}

interface PrSynced {
  pr?: string;
  title?: string | null;
  url?: string | null;
  repo?: string | null;
  head_ref?: string | null;
  additions?: number;
  deletions?: number;
  branch_age_days?: number | null;
  merged_at?: string | null;
  closed_at?: string | null;
  is_draft?: boolean;
}

/**
 * My open PRs classified by state, derived from the event stream (no PR table):
 * latest `pr_synced` per PR (by `event.id` — `ts` is fixed at creation, so a
 * post-merge re-sync collides on `ts`; `id` breaks the tie). Open = merged_at &
 * closed_at both null. authoring=draft; addressing-comments=has an after-ready
 * non-bot pr_comment; waiting-review=neither.
 */
export function inFlightPrs(db: Database): InFlightPr[] {
  const rows = orm(db)
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.source, "github"), eq(event.type, "pr_synced")))
    .orderBy(asc(event.id))
    .all() as { payload: string | null }[];

  const out: InFlightPr[] = [];
  for (const [pr, p] of latestPrSynced(rows)) {
    if (p.merged_at || p.closed_at) continue; // not in flight
    const human = orm(db)
      .select({ one: sql`1` })
      .from(prComment)
      .where(and(eq(prComment.pr, pr), eq(prComment.afterReady, 1), eq(prComment.bot, 0)))
      .limit(1)
      .get();
    out.push(shapeInFlightPr(pr, p, !!human));
  }
  return out;
}

/**
 * The store-aware form of `inFlightPrs()` (337). The synchronous form stays for `ob brief`, which is not
 * ported; both share the pure `latestPrSynced` and `shapeInFlightPr`, so the two engines cannot classify
 * the same PR differently.
 *
 * Orderings: `event.id` ASC is the primary key on both engines -- and it is load-bearing rather than
 * cosmetic, because "latest facts win" is expressed as a later row OVERWRITING an earlier one in the map.
 * `event.ts` cannot be used for that: it is fixed at creation, so a post-merge re-sync collides on it.
 *
 * `pr_comment.after_ready` and `.bot` are plain 0/1 integer columns on BOTH engines (never a boolean
 * column), so `eq(col, 1)` is correct on each and `eq(col, false)` -- the Postgres type error -- is not
 * reachable here. The result is read as "did a row come back", never as a value.
 */
export async function inFlightPrsFor(db: Database | Store): Promise<InFlightPr[]> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ payload: s.t.event.payload })
    .from(s.t.event)
    .where(and(eq(s.t.event.source, "github"), eq(s.t.event.type, "pr_synced")))
    .orderBy(asc(s.t.event.id))) as { payload: string | null }[];

  const out: InFlightPr[] = [];
  for (const [pr, p] of latestPrSynced(rows)) {
    if (p.merged_at || p.closed_at) continue; // not in flight
    const human = (await s.q
      .select({ one: sql`1` })
      .from(s.t.prComment)
      .where(and(eq(s.t.prComment.pr, pr), eq(s.t.prComment.afterReady, 1), eq(s.t.prComment.bot, 0)))
      .limit(1)) as Array<{ one: unknown }>;
    out.push(shapeInFlightPr(pr, p, human.length > 0));
  }
  return out;
}

/** Latest `pr_synced` facts per PR, from id-ordered rows (a later row overwrites). Pure. */
function latestPrSynced(rows: Array<{ payload: string | null }>): Map<string, PrSynced> {
  const latest = new Map<string, PrSynced>();
  for (const r of rows) {
    if (!r.payload) continue;
    let p: PrSynced;
    try {
      p = JSON.parse(r.payload) as PrSynced;
    } catch {
      continue;
    }
    if (p.pr) latest.set(p.pr, p); // later id overwrites → latest facts win
  }
  return latest;
}

/** One in-flight PR row, including its state classification. Pure, and shared by both forms. */
function shapeInFlightPr(pr: string, p: PrSynced, hasHumanComment: boolean): InFlightPr {
  return {
    pr,
    title: p.title ?? null,
    url: p.url ?? null,
    repo: p.repo ?? null,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    branch_age_days: p.branch_age_days ?? null,
    state: p.is_draft ? "authoring" : hasHumanComment ? "addressing-comments" : "waiting-review",
  };
}

// Most-actionable first.
const PR_STATE_ORDER: PrState[] = ["addressing-comments", "waiting-review", "authoring"];

export interface StatusSnapshot {
  agents: AgentStatusRow[];
  needs_review: AgentStatusRow[];
  working: AgentStatusRow[];
  in_flight_prs: InFlightPr[];
  blocked: OpenItem[];
  live_deploy: DeployRow | null;
  focus: OpenItem[];
  frontier: FrontierView | null;
  journal: ReturnType<typeof orderJournal>;
  completed_spinoffs: SpinoffRow[]; // recently reconciled-to-done spinoffs (#36): so the architect sees results
  /**
   * Why the frontier section is absent, when it is absent for a reason worth saying (337). Null when the
   * frontier is present, and null when it is absent for the reasons it always could be (no wayfinder dir
   * near cwd, a fetch that failed) — those stay silent, as they always have.
   */
  frontier_note: string | null;
}

/**
 * Assemble the `ob status` snapshot (046). Pure read — the UI's status server fn calls this too (079/082).
 * `fetchIssues` is an injectable seam for the wayfinder frontier (221) so tests never hit GitHub; prod
 * omits it and the reader uses the live GraphQL fetch.
 */
export async function buildStatus(db: Database | Store, fetchIssues?: IssueFetcher): Promise<StatusSnapshot> {
  const s = asStore(db);
  const agents = await listAgents(s);
  const open = await openItemsFor(s);
  // The LIVE frontier fetch needs a GitHub token from the unported credential path, so under Postgres it
  // is named rather than silently omitted — an absent section reads exactly like an empty frontier. An
  // INJECTED fetcher (the dashboard, the tests) needs no token and runs on either engine.
  const frontierBlocked = s.kind === "postgres" && !fetchIssues;
  return {
    agents,
    // The "needs a human" bucket: `needs-human` is the LIVE word a builder stamps when it parks on the owner,
    // and `manual-review` is the RETIRED one old rows still hold (1189 — read here, never written). Both
    // belong in this section; a builder waiting on the human must not read as an ordinary working agent.
    needs_review: agents.filter((a) => a.status === "needs-human" || a.status === "manual-review"),
    working: agents.filter((a) => a.status !== "needs-human" && a.status !== "manual-review"),
    in_flight_prs: await inFlightPrsFor(s),
    blocked: open.filter((i) => i.status === "blocked"),
    live_deploy: notOkLiveDeploy(await listDeploys(s)),
    focus: open.filter((i) => i.today_rank !== null),
    frontier: frontierBlocked ? null : await readFrontier(s, process.cwd(), fetchIssues), // (060/221)
    frontier_note: frontierBlocked ? FRONTIER_UNDER_POSTGRES : null,
    journal: orderJournal(await listJournal(s, { since: new Date(Date.now() - 24 * 3600 * 1000).toISOString() })),
    completed_spinoffs: await recentlyDoneSpinoffs(s), // recently done spinoffs (#36) — cheap, newest first
  };
}

/**
 * The snapshot PLUS everything the human rendering needs to be a PURE function of it (353).
 *
 * `ob status` used to build and render in one pass, reaching back into the store for the triage count
 * and a journal handle's real name while it wrote the lines. An API client has
 * no store to reach back into, so those reads move into the report and the renderer becomes pure.
 * Both paths -- the local command and `GET /status` -- then run the SAME renderer over the SAME report,
 * which is what stops the two wordings drifting apart.
 */
export interface StatusReport extends StatusSnapshot {
  /** The triage-inbox banner's count. */
  triage_count?: number;
  /** journal handle -> the person's real name, when the registry knows one. */
  journal_about?: Record<string, string>;
  /**
   * T3's live threads (1124). Optional because it is read on THIS machine — the API host has no T3 — so a
   * report that came over the wire without it renders without the block, and a caller that read it
   * attaches it. An ABSENT block is different from an EMPTY one: absent means nobody asked.
   */
  threads?: T3ReadView;
}

// Every enrichment field is OPTIONAL because ob 353's API client renders this from `GET /status`, which
// answers with the plain StatusSnapshot. Absent means the renderer degrades VISIBLY -- a journal handle prints
// as itself rather than acquiring a name that is not its own, and the triage banner is simply not
// claimed. A wrong label would be the ob 237 class; a missing one is not.

/** Assemble the report `ob status` and `GET /status` both render (353). */
export async function buildStatusReport(db: Database | Store, fetchIssues?: IssueFetcher): Promise<StatusReport> {
  const s = asStore(db);
  const snapshot = await buildStatus(s, fetchIssues);
  const journalAbout: Record<string, string> = {};
  for (const e of snapshot.journal) {
    if (!e.about || journalAbout[e.about]) continue;
    const person = await resolvePersonFor(s, e.about);
    if (person?.real_name) journalAbout[e.about] = person.real_name;
  }
  return {
    ...snapshot,
    triage_count: await triageCount(s),
    journal_about: journalAbout,
  };
}

/** The `--json` body of `ob status`. Pure. */
export function statusJson(s: StatusReport): string {
  const byState = (st: PrState) => s.in_flight_prs.filter((p) => p.state === st);
  return JSON.stringify(
    {
      agents: s.agents,
      needs_review: s.needs_review,
      in_flight_prs: {
        "addressing-comments": byState("addressing-comments"),
        "waiting-review": byState("waiting-review"),
        authoring: byState("authoring"),
      },
      blocked: s.blocked,
      live_deploy: s.live_deploy ?? null,
      focus: s.focus,
      frontier: s.frontier ? s.frontier.takeable.map((t) => ({ id: t.id, title: t.title })) : [],
      frontier_note: s.frontier_note,
      // 1124: T3's live threads, read on THIS machine. `null` = not read (an API host has no T3);
      // `error` set = T3 could not be read, which the human view says in words too.
      threads: s.threads
        ? {
            threads: s.threads.threads,
            needs_you: s.threads.needsYou.map((t) => t.threadId),
            unreadable: s.threads.unreadable,
            truncated: s.threads.truncated,
            error: s.threads.error,
            rows_error: s.threads.rowsError,
          }
        : null,
      journal: s.journal,
      completed_spinoffs: s.completed_spinoffs.map((r) => ({
        ticket: r.ticket_ref,
        branch: r.branch,
        repo: r.repo,
      })),
    },
    null,
    2,
  );
}

/** The human/table rendering of `ob status`. Pure: everything it needs is on the report. */
export function renderStatusReport(s: StatusReport): string {
  const { needs_review: needsReview, working, in_flight_prs: prs, blocked, live_deploy: liveDeploy, focus, frontier, journal, completed_spinoffs: completedSpinoffs } = s;
  const out: string[] = ["Status — what's happening now"];

  const banner = triageBanner(s.triage_count ?? 0);
  if (banner) out.push("", banner);

  if (needsReview.length) {
    out.push("", "⚠ Needs review (waiting on a human — a question, or a worktree to look at)");
    out.push(
      needsReview
        .map((a) => `  ${a.id}\t${a.ticket ?? "-"}\t${a.branch ?? "-"}${a.note ? `\t— ${a.note}` : ""}`)
        .join("\n"),
    );
  }

  out.push("", "Agents");
  if (working.length === 0) {
    out.push("  (none)");
  } else {
    for (const a of working) out.push(`  ${a.id}\t${agentStateLabel(a.status, a.run)}\t${a.ticket ?? "-"}\t${a.branch ?? "-"}`);
  }

  // 1124: T3's live threads. Present when T3 answered, and ONE line saying it could not be read when it
  // did not — a silently missing section reads as "nothing is running", which is the failure this stops.
  if (s.threads) {
    out.push("", "Threads");
    out.push(...renderT3ThreadsBlock(s.threads));
  }

  if (completedSpinoffs.length) {
    out.push("", "Recently completed spinoffs");    for (const r of completedSpinoffs) {
      const ready = r.status === "ready-for-gate" ? " · handed-off" : "";
      out.push(`  ✓ ${r.ticket_ref} · ${r.branch}${ready}`);
    }
  }

  out.push("", "In-flight PRs");
  if (prs.length === 0) {
    out.push("  (none)");
  } else {
    const sorted = [...prs].sort((a, b) => PR_STATE_ORDER.indexOf(a.state) - PR_STATE_ORDER.indexOf(b.state));
    for (const p of sorted) {
      const age = p.branch_age_days != null ? `, ${p.branch_age_days}d` : "";
      out.push(`  [${p.state}] ${p.pr}  ${p.title ?? ""}  (+${p.additions}/-${p.deletions}${age})`);
    }
  }

  out.push("", "Blocked");
  out.push(
    blocked.length
      ? blocked
          .map((i) => `  ${i.ref ?? i.id} ${i.title} — ${i.block_reason ?? "?"}${i.block_owner ? ` (${i.block_owner})` : ""}`)
          .join("\n")
      : "  (none)",
  );

  if (liveDeploy) {
    out.push("", "Live deploy");
    out.push(`  ${liveDeploy.result}  ${liveDeploy.target}  ${liveDeploy.host}  ${liveDeploy.unit}  ${liveDeploy.sha}  ${liveDeploy.at}`);
  }

  out.push("", "Today's focus");
  out.push(focus.length ? focus.map((i) => `  ${i.ref ?? i.id} ${i.title}`).join("\n") : "  (none)");

  if (frontier && (frontier.takeable.length || frontier.blocked)) {
    out.push("", "Frontier — takeable tickets");
    out.push(
      frontier.takeable.length
        ? frontier.takeable.map((t) => `  ${t.id}  ${t.title}`).join("\n")
        : "  (none takeable)",
    );
    if (frontier.blocked) out.push(`  (+${frontier.blocked} more open — blocked or claimed)`);
  }

  if (s.frontier_note) out.push("", "Frontier — takeable tickets", `  (${s.frontier_note})`);

  out.push("", "Recent journal (24h)");
  if (journal.length === 0) {
    out.push("  (none)");
  } else {
    for (const e of journal) {
      const about = e.about ? ` — about ${s.journal_about?.[e.about] ?? e.about}` : "";
      out.push(`  [${e.type}] ${e.text}${about}`);
    }
  }

  return out.join("\n");
}

/**
 * Attach T3's live threads to a report (1124). A helper rather than part of `buildStatusReport` because
 * T3 lives on THIS machine while the report's data comes from the store or the API: both callers read the
 * same block the same way, and neither can forget it. Never throws — T3 being down is a line in the
 * block, not a failed status.
 */
export async function attachT3Threads(report: StatusReport, source: T3RowSource): Promise<StatusReport> {
  report.threads = await readT3View(source);
  return report;
}

export async function cmdStatus(ctx: Ctx): Promise<void> {
  const store = asStore(ctx.store ?? ctx.db);
  const s = await buildStatusReport(store);
  await attachT3Threads(s, storeT3RowSource(store));
  print(ctx.mode === "json" ? statusJson(s) : renderStatusReport(s));
}

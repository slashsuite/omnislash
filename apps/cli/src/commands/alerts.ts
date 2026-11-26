import { sql } from "drizzle-orm";
import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { eventsBetweenFor, parsePayload, nowIso } from "../events.ts";
import { settingNumFor } from "../settings.ts";
import { getFocusProject } from "../config.ts";
import { queryItems, type ItemRow } from "../items.ts";
import { jobHealth } from "../jobs.ts";
import { sendHaNotify } from "../notify.ts";
import { CREDENTIALS, lastCredentialChecks } from "../credentials.ts";
import { effectivePriority, PRIORITY_CRITICAL, PRIORITY_FLAKE, PRIORITY_HIGH, PRIORITY_URGENT } from "../priority.ts";
import { print } from "../output.ts";
import type { Store } from "../db/store.ts";
import { openCiNotices } from "../ci-main.ts";

/** A surfaced alert. `key` is stable (`rule:entity`); `state_hash` encodes the
 * underlying state so a snooze auto-expires once that state changes. */
export interface Alert {
  key: string;
  rule: number;
  label: string;
  entity: string; // PR ref, ticket, or local item id
  message: string;
  state_hash: string;
}

const LABELS: Record<number, string> = {
  1: "PR unreviewed",
  2: "aging",
  3: "stale branch",
  4: "blocked",
  7: "job failing",
  8: "job stale",
  9: "job never ran",
  10: "job interrupted",
  11: "credential invalid",
  12: "main red",
};

/** Critical (OS-108), urgent, flake (OB-2060, above high) or high: the levels worth surfacing. */
function isHighPri(eff: number): boolean {
  return eff === PRIORITY_CRITICAL || eff === PRIORITY_URGENT || eff === PRIORITY_FLAKE || eff === PRIORITY_HIGH;
}

function ageHours(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
}

function ageDays(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
}

const fmtH = (h: number) => `${Math.max(0, Math.floor(h))}h`;
const fmtD = (d: number) => `${Math.max(0, Math.floor(d))}d`;

/** A duration in seconds as the largest unit that still reads as a number: 300 -> 5m, 86400 -> 1d. */
function fmtSecs(s: number): string {
  const n = Math.max(0, Math.floor(s));
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m`;
  if (n < 86_400) return `${Math.floor(n / 3600)}h`;
  return `${Math.floor(n / 86_400)}d`;
}

/** The part of a failure that identifies WHICH failure, for the snooze's state_hash. */
const errorSignature = (e: string | null) => (e ?? "").slice(0, 120);

/** "https://github.com/owner/repo/pull/123" -> "owner/repo#123". Passes through
 * an already-canonical "owner/repo#123". Returns null if unrecognizable. */
export function parsePrRef(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) return `${m[1]}/${m[2]}#${m[3]}`;
  if (/^[^/]+\/[^/]+#\d+$/.test(url)) return url;
  return null;
}

function effOf(item: ItemRow, focusProject: string | null): number {
  return effectivePriority({
    priority: item.priority,
    projectId: item.project_id,
    focusProject,
  });
}

interface ComputeOpts {
  now?: string;
  focusProject: string | null;
}

/**
 * Evaluate all five surfacing rules against items + ingested events.
 * Pure/sync — no network, no stdout, no snooze filtering (see filterSnoozed).
 */
export async function computeAlerts(store: Store, opts: ComputeOpts): Promise<Alert[]> {
  const now = opts.now ?? nowIso();
  const focus = opts.focusProject;
  const alerts: Alert[] = [];

  const unreviewedHrs = await settingNumFor(store, "alert_pr_unreviewed_hours");
  const agingDays = await settingNumFor(store, "alert_aging_days");
  const blockedDays = await settingNumFor(store, "alert_blocked_days");
  const branchAgeMax = await settingNumFor(store, "branch_age_days");
  const jobInterruptions = await settingNumFor(store, "alert_job_interruptions");

  // --- Event indexes -------------------------------------------------------
  const prUrlByItem = new Map<string, string | null>();
  for (const r of (await store.q
    .select({ item_id: store.t.taskDetail.item_id, pr_url: store.t.taskDetail.pr_url })
    .from(store.t.taskDetail)) as Array<{ item_id: string; pr_url: string | null }>) {
    prUrlByItem.set(r.item_id, r.pr_url);
  }

  const readyAtByPr = new Map<string, string>(); // latest ready_at per PR
  for (const row of await eventsBetweenFor(store, { source: "github", type: "ready_for_review" })) {
    const p = parsePayload<{ pr?: string; ready_at?: string }>(row);
    if (p.pr) readyAtByPr.set(p.pr, p.ready_at ?? row.ts);
  }

  const reviewsByPr = new Map<string, string[]>(); // ts of non-self reviews after ready
  for (const t of ["review", "review_comment"] as const) {
    for (const row of await eventsBetweenFor(store, { source: "github", type: t })) {
      const p = parsePayload<{ pr?: string; after_ready?: boolean }>(row);
      if (!p.pr || p.after_ready !== true) continue;
      const list = reviewsByPr.get(p.pr) ?? [];
      list.push(row.ts);
      reviewsByPr.set(p.pr, list);
    }
  }

  const prSync = new Map<
    string,
    { pr: string; branch_age_days: number | null; merged_at: string | null }
  >();
  for (const row of await eventsBetweenFor(store, { source: "github", type: "pr_synced" })) {
    const p = parsePayload<{
      pr?: string;
      branch_age_days?: number | null;
      merged_at?: string | null;
    }>(row);
    if (p.pr) {
      prSync.set(p.pr, {
        pr: p.pr,
        branch_age_days: p.branch_age_days ?? null,
        merged_at: p.merged_at ?? null,
      });
    }
  }

  // --- Rule 1: high-priority PR unreviewed ---------------------------------
  for (const item of await queryItems(store, { status: "ready" })) {
    if (!isHighPri(effOf(item, focus))) continue;
    const pr = parsePrRef(prUrlByItem.get(item.id));
    let baseTs = item.updated_at;
    let reviewCount = 0;
    let latestReview = "";
    if (pr && readyAtByPr.has(pr)) {
      baseTs = readyAtByPr.get(pr)!;
      const revs = reviewsByPr.get(pr) ?? [];
      reviewCount = revs.length;
      if (reviewCount > 0) {
        latestReview = revs.slice().sort()[revs.length - 1]!;
        continue; // has a non-self review after ready — nothing to nag
      }
    }
    const hrs = ageHours(baseTs, now);
    if (hrs <= unreviewedHrs) continue;
    const entity = pr ?? item.id;
    alerts.push({
      key: `pr_unreviewed:${entity}`,
      rule: 1,
      label: LABELS[1]!,
      entity,
      message: `high-priority PR ready ${fmtH(hrs)} with no review yet — ping the reviewer`,
      state_hash: `${reviewCount}:${latestReview}:${item.updated_at}`,
    });
  }

  // --- Rule 2: aging high-priority work ------------------------------------
  for (const item of await queryItems(store, { open: true })) {
    if (item.status === "blocked" || item.status === "ready") continue;
    if (!isHighPri(effOf(item, focus))) continue;
    const days = ageDays(item.updated_at, now);
    if (days <= agingDays) continue;
    alerts.push({
      key: `aging:${item.id}`,
      rule: 2,
      label: LABELS[2]!,
      entity: item.id,
      message: `high-priority work untouched ${fmtD(days)}: "${item.title}"`,
      state_hash: item.updated_at,
    });
  }

  // --- Rule 3: stale branch ------------------------------------------------
  for (const p of prSync.values()) {
    if (p.merged_at !== null) continue;
    if (p.branch_age_days === null || p.branch_age_days <= branchAgeMax) continue;
    alerts.push({
      key: `stale_branch:${p.pr}`,
      rule: 3,
      label: LABELS[3]!,
      entity: p.pr,
      message: `branch open ${p.branch_age_days}d (> ${branchAgeMax}d) and not merged`,
      state_hash: `${p.branch_age_days}:open`,
    });
  }

  // --- Rule 4: blocked, no movement ----------------------------------------
  for (const item of await queryItems(store, { status: "blocked" })) {
    const days = ageDays(item.updated_at, now);
    if (days <= blockedDays) continue;
    const reason = item.block_reason ? ` (${item.block_reason})` : "";
    alerts.push({
      key: `blocked:${item.id}`,
      rule: 4,
      label: LABELS[4]!,
      entity: item.id,
      message: `blocked ${fmtD(days)} with no movement${reason}: "${item.title}" — chase it`,
      state_hash: item.updated_at,
    });
  }

  // --- Rule 5, retired (1121) ----------------------------------------------
  // 'epic churned' read epic_snapshot, and NOTHING has written that table since the Cue/Linear ingest
  // went (ob 619): the rule could never fire again, and its message pointed at `ob metrics epic_churn`,
  // which 1121 deleted with the rest of the measurement layer. The label is dropped rather than
  // renumbered so an existing snooze key, and every rule number printed anywhere else, still means
  // what it meant.

  // --- Rule 6, retired ------------------------------------------------------
  // 'overdue contact' read a per-person contact cadence that is not part of this product. The number is
  // left unused so every other rule number keeps its meaning.

  // --- Rules 7/8/9: daemon job health (218) --------------------------------
  // Four jobs each failed silently for weeks and every one was found by a person opening a log file. A
  // job produces AT MOST ONE alert: failing, stale and never-ran are three readings of the same silence,
  // and a job that is failing is by construction also not succeeding, so emitting both would double every
  // outage. `jobHealth` picks the shape; this loop only turns it into a row.
  for (const h of await jobHealth(store, { now })) {
    if (h.state === "failing") {
      const since = h.last_success_at ? `last succeeded ${fmtSecs(h.quiet_s ?? 0)} ago` : "has never succeeded";
      const why = h.last_error ? `. Last error: ${h.last_error}` : "";
      alerts.push({
        key: `job_failing:${h.job}`,
        rule: 7,
        label: LABELS[7]!,
        entity: h.job,
        message: `${h.job} has failed ${h.consecutive_failures} times in a row and ${since}${why}`,
        // The failure COUNT is deliberately not in the hash: it moves on every run, so a snooze would
        // reappear minutes later for the same job failing the same way. A snooze here lasts until it
        // succeeds or until it starts failing for a different reason, which are the two things worth
        // being told about.
        state_hash: `${h.last_success_at ?? "never"}:${errorSignature(h.last_error)}`,
      });
      continue;
    }
    if (h.state === "stale") {
      alerts.push({
        key: `job_stale:${h.job}`,
        rule: 8,
        label: LABELS[8]!,
        entity: h.job,
        message: `${h.job} has not succeeded in ${fmtSecs(h.quiet_s ?? 0)} (scheduled every ${fmtSecs(h.cadence_s ?? 0)}). Read its log`,
        state_hash: h.last_success_at ?? "never",
      });
      continue;
    }
    if (h.state === "never_ran") {
      alerts.push({
        key: `job_never_ran:${h.job}`,
        rule: 9,
        label: LABELS[9]!,
        entity: h.job,
        message: `${h.job} is declared (every ${fmtSecs(h.cadence_s ?? 0)}) but has never run here: it is installed nowhere, or its timer is not loaded`,
        // Constant, so an "I know, it is off on purpose" snooze holds until the job actually runs for
        // the first time, at which point the alert is gone anyway.
        state_hash: "never",
      });
      continue;
    }
    // Rule 10: runs that start and never finish (221). Deliberately gated on REPETITION, not on a single
    // interruption: a laptop closing mid-sync, a reboot and a launchd timeout on a slow network all
    // produce one of these and none of them is a broken job, so alerting on the first would cry wolf
    // exactly the way the 82 no-op "failures" did. A job that dies EVERY run is the case that must not
    // stay quiet, and it is the one this catches, well before rule 8's 24-hour floor would.
    if (h.state === "interrupted" && h.consecutive_interruptions >= jobInterruptions) {
      alerts.push({
        key: `job_interrupted:${h.job}`,
        rule: 10,
        label: LABELS[10]!,
        entity: h.job,
        message: `${h.job} has started and never finished ${h.consecutive_interruptions} times in a row (latest run unresolved for ${fmtSecs(h.unresolved_for_s ?? 0)}): it is being killed or timing out. Read its log`,
        // As with rule 7, the count is out of the hash: it moves on every run, so including it would
        // undo a snooze minutes later for the same job dying the same way.
        state_hash: h.last_success_at ?? "never",
      });
    }
  }

  // --- Rule 11: a credential that FAILED its last live check (219) ---------
  // The layer under rules 7/8/9: a failing job is usually a broken credential seen from the other end.
  // Only a check that actually RAN and came back bad produces a row. A credential that is simply absent
  // does not, and that is deliberate: absence is often a decision (slack was not stored for months on
  // purpose, the master key file exists only on the server), so alerting on it would leave a permanent
  // row nobody can clear, and the tokens page already shows absence at a glance. "Stored but rejected by
  // the provider" is the opposite: nothing about it is intentional, and it is exactly the silence that
  // cost 17 days of gmail.
  for (const c of await lastCredentialChecks(store)) {
    if (c.ok) continue;
    const spec = CREDENTIALS.find((s) => s.name === c.name);
    if (!spec) continue;
    alerts.push({
      key: `credential_invalid:${c.name}`,
      rule: 11,
      label: LABELS[11]!,
      entity: c.name,
      message: `${spec.label} failed its last check ${fmtSecs(Math.max(0, (Date.parse(now) - Date.parse(c.checked_at)) / 1000))} ago: ${c.detail ?? "no reason recorded"}. Refresh it with \`${spec.command}\``,
      // The failure REASON, not the timestamp: re-checking a still-broken credential must not undo a
      // snooze, while a credential that starts failing differently is worth being told about again.
      state_hash: `fail:${errorSignature(c.detail)}`,
    });
  }

  // --- Rule 12: main is red (OB-2276) --------------------------------------
  // A red run on `main` the webhook (or the hourly catch-up) told the team's thread about, or recorded with
  // nobody to tell for a project in no team, until the first green run of that workflow. One alert per repo and
  // workflow, naming its latest red run; a new red run changes the hash, so a snooze lasts for that run only.
  const latestRed = new Map<string, Awaited<ReturnType<typeof openCiNotices>>[number]>();
  for (const n of await openCiNotices(store)) latestRed.set(`${n.repo}:${n.workflow_id}`, n);
  for (const [key, n] of latestRed) {
    alerts.push({
      key: `main_red:${key}`,
      rule: 12,
      label: LABELS[12]!,
      entity: `${n.repo} · ${n.workflow}`,
      message: `${n.conclusion} on main at ${(n.sha ?? "").slice(0, 7)} since ${n.told_at}${n.target ? `, told ${n.target}` : ", nobody was told (the project is in no team, or the repo is no project's remote)"}: ${n.run_url ?? "no run url"}`,
      state_hash: n.run_id,
    });
  }

  alerts.sort((a, b) => a.rule - b.rule || a.key.localeCompare(b.key));
  return alerts;
}

/** Drop alerts that have a matching snooze whose state_hash is still current.
 *
 *  One read of the whole (tiny) ack table rather than a query per alert: against an in-process handle a
 *  row-at-a-time lookup was free, and against a connection it is a round trip per surfaced alert. */
export async function filterSnoozed(store: Store, alerts: Alert[]): Promise<Alert[]> {
  if (alerts.length === 0) return [];
  const acks = new Map<string, string | null>();
  for (const row of (await store.q
    .select({ alert_key: store.t.alertAck.alert_key, state_hash: store.t.alertAck.state_hash })
    .from(store.t.alertAck)) as Array<{ alert_key: string; state_hash: string | null }>) {
    acks.set(row.alert_key, row.state_hash);
  }
  return alerts.filter((a) => {
    if (!acks.has(a.key)) return true;
    return acks.get(a.key) !== a.state_hash; // shown again once state changes
  });
}

/**
 * Snooze (a.k.a. ack) an alert by key: records an `alert_ack` pinned to the alert's CURRENT state_hash,
 * so it stays suppressed until the underlying state changes (see filterSnoozed). Idempotent (upsert on
 * the key). Throws UsageError when no active alert has that key. The single write path for both the CLI
 * `ob alerts snooze` and the dashboard ack/snooze action — no duplicated SQL. Never sends anything.
 */
export async function snoozeAlert(store: Store, key: string, focusProject: string | null): Promise<void> {
  const target = (await computeAlerts(store, { focusProject })).find((a) => a.key === key);
  if (!target) throw new UsageError(`no active alert with key '${key}'`);
  await store.q
    .insert(store.t.alertAck)
    .values({ alert_key: key, state_hash: target.state_hash, snoozed_at: nowIso() })
    .onConflictDoUpdate({
      target: store.t.alertAck.alert_key,
      set: { state_hash: sql`excluded.state_hash`, snoozed_at: sql`excluded.snoozed_at` },
    });
}

export function renderAlerts(alerts: Alert[]): string {
  if (alerts.length === 0) return "No alerts.";
  return alerts.map((a) => `${a.label.toUpperCase().padEnd(13)} ${a.entity}\t${a.message}`).join("\n");
}

export function renderAlertDigest(alerts: Alert[]): string {
  if (alerts.length === 0) return "OmniSlash: no alerts.";
  const lines = [`OmniSlash: ${alerts.length} alert${alerts.length === 1 ? "" : "s"} need attention`];
  for (const a of alerts) lines.push(`• [${a.label}] ${a.entity}: ${a.message}`);
  return lines.join("\n");
}

/**
 * ob 1687: the rules that may reach his phone. A push has to be something he can act on today: a job that
 * failed, went stale or never ran (7/8/9/10), a credential the provider rejected (11), a blocked item with no
 * movement (4). Everything else stays in the printed digest and `ob alerts`, never on the phone: aging (2),
 * and also PR unreviewed (1) and stale branch (3), which are nudges, not outages. There is no deadline rule yet; when one lands, add its number here.
 */
export const PUSH_RULES: ReadonlySet<number> = new Set([4, 7, 8, 9, 10, 11]);

/** The alerts worth a push: `alerts` filtered to PUSH_RULES. */
export function pushWorthy(alerts: Alert[]): Alert[] {
  return alerts.filter((a) => PUSH_RULES.has(a.rule));
}

/**
 * ob 1655: `--digest --notify` is the 08:00 job, and it reaches the owner as ONE push. Since
 * 1687 that push carries only `pushWorthy` alerts, so a morning with nothing but aging
 * nudges sends nothing (the printed digest still lists them). Nothing is sent without the explicit
 * `--notify`, so a person typing `ob alerts --digest` never buzzes their own phone.
 */
async function notifyDigest(ctx: Ctx, alerts: Alert[]): Promise<void> {
  if (!ctx.flags.notify) return;
  const important = pushWorthy(alerts);
  if (important.length === 0) return;
  const n = important.length;
  await sendHaNotify(
    ctx.store,
    { title: `OmniSlash: ${n} alert${n === 1 ? "" : "s"}`, body: renderAlertDigest(important) },
    { fetch: ctx.notifyFetch },
  );
}

export async function cmdAlerts(ctx: Ctx): Promise<void> {
  const focusProject = await getFocusProject(ctx.store);

  if (ctx.args[0] === "snooze") {
    const key = ctx.args[1];
    if (!key) throw new UsageError("alerts snooze requires a <key>");
    await snoozeAlert(ctx.store, key, focusProject);
    if (ctx.mode === "json") print(JSON.stringify({ snoozed: key }, null, 2));
    else if (ctx.mode !== "quiet") print(`snoozed ${key}`);
    return;
  }

  const alerts = await filterSnoozed(ctx.store, await computeAlerts(ctx.store, { focusProject }));

  if (ctx.mode === "json") {
    print(JSON.stringify(alerts, null, 2));
    return;
  }
  if (ctx.mode === "quiet") {
    print(alerts.map((a) => a.key).join("\n"));
    return;
  }

  if (ctx.flags.digest) {
    print(renderAlertDigest(alerts));
    await notifyDigest(ctx, alerts);
    return;
  }
  print(renderAlerts(alerts));
}

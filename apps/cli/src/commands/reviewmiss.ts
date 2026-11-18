import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { nowIso } from "../db.ts";
import { recordEventFor, eventsBetweenFor, parsePayload } from "../events.ts";

const HALF_LIFE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ReviewMissPayload {
  pr: string;
  class: string;
  finding: string;
  scope: string;
}

/**
 * Derive a scope from a PR url: the `owner/repo` segment of a GitHub url,
 * else 'global'. Accepts https/ssh forms.
 */
export function scopeFromPr(pr: string): string {
  const m = pr.match(/github\.com[/:]+([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i);
  if (m) return `${m[1]}/${m[2]}`;
  return "global";
}

export interface RankedClass {
  class: string;
  count: number;
  last_seen: string;
  weight: number;
}

/**
 * Rank miss-classes by a recency-decayed weight so a class seen often + recently
 * outranks a stale one-off. Pure + unit-testable.
 *
 *   weight = Σ over occurrences of  0.5 ^ (ageDays / halfLifeDays)
 *
 * halfLifeDays (default 90): an occurrence's contribution halves every 90 days.
 * A fresh occurrence contributes ~1.0; a 90-day-old one ~0.5; a 180-day-old one
 * ~0.25. count is the raw number of occurrences; last_seen is the newest ts.
 *
 * scope filter (when opts.scope set): keeps events whose scope matches opts.scope
 * OR is 'global' (or unset) — universal misses always apply, repo-specific ones
 * only within their repo.
 */
export function rankClasses(
  events: { class: string; ts: string; scope?: string }[],
  now: Date,
  opts?: { halfLifeDays?: number; scope?: string; limit?: number },
): RankedClass[] {
  const halfLife = opts?.halfLifeDays ?? HALF_LIFE_DAYS;
  const limit = opts?.limit ?? 10;
  const scope = opts?.scope;
  const nowMs = now.getTime();

  const agg = new Map<string, { count: number; last_seen: string; weight: number }>();
  for (const ev of events) {
    if (scope !== undefined) {
      const s = ev.scope ?? "global";
      if (s !== scope && s !== "global") continue;
    }
    const ageDays = Math.max(0, (nowMs - new Date(ev.ts).getTime()) / DAY_MS);
    const contribution = Math.pow(0.5, ageDays / halfLife);
    const cur = agg.get(ev.class);
    if (cur) {
      cur.count += 1;
      cur.weight += contribution;
      if (ev.ts > cur.last_seen) cur.last_seen = ev.ts;
    } else {
      agg.set(ev.class, { count: 1, last_seen: ev.ts, weight: contribution });
    }
  }

  return [...agg.entries()]
    .map(([cls, v]) => ({ class: cls, count: v.count, last_seen: v.last_seen, weight: v.weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

export async function cmdReviewMiss(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];

  if (sub === "add") {
    const pr = ctx.flags.pr;
    const cls = ctx.flags.class;
    if (!pr) throw new UsageError("review-miss add requires --pr <url>");
    if (!cls) throw new UsageError("review-miss add requires --class <tag>");
    const finding = ctx.args.slice(1).join(" ");
    if (!finding) throw new UsageError('review-miss add requires a "<finding>"');
    const scope = ctx.flags.scope ?? scopeFromPr(pr);

    const payload: ReviewMissPayload = { pr, class: cls, finding, scope };
    await recordEventFor(ctx.store, {
      ts: nowIso(),
      source: "skill:code-review",
      type: "review_miss",
      payload,
    });

    if (ctx.mode === "json") {
      print(JSON.stringify({ class: cls, scope, pr }));
    } else if (ctx.mode !== "quiet") {
      print(`recorded review_miss: ${cls} (scope: ${scope})`);
    }
    return;
  }

  if (sub === "top") {
    const scope = ctx.flags.scope;
    const limit = ctx.flags.limit ? Number(ctx.flags.limit) : 10;
    if (Number.isNaN(limit) || limit < 1) throw new UsageError("--limit must be a positive integer");

    const rows = await eventsBetweenFor(ctx.store, { type: "review_miss" });
    const events = rows
      .map((r) => ({ p: parsePayload<ReviewMissPayload>(r), ts: r.ts }))
      .filter(({ p }) => typeof p.class === "string" && p.class.length > 0)
      .map(({ p, ts }) => ({ class: p.class, ts, scope: p.scope ?? "global" }));

    const ranked = rankClasses(events, new Date(), { scope, limit });

    if (ctx.mode === "json") {
      print(JSON.stringify(ranked, null, 2));
      return;
    }
    if (ranked.length === 0) {
      if (ctx.mode !== "quiet") print("no review misses recorded");
      return;
    }
    print(
      ranked
        .map((r) => `${r.class}\t${r.count}\t${r.last_seen}\tweight=${r.weight.toFixed(3)}`)
        .join("\n"),
    );
    return;
  }

  throw new UsageError(`unknown review-miss subcommand '${sub ?? ""}' (add|top)`);
}

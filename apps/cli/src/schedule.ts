// OS-310: the schedule half of a scheduled job. `computeNextRunAt` reads a job's schedule kind and expression and
// gives the next time it is due after a moment, or refuses the expression. Pure: no clock, no store.
//
// - `once`: an ISO timestamp with a date and a time; the job is due at that instant.
// - `interval`: a whole number and a unit (`90s`, `15m`, `1h`, `6h`, `1d`), at least 60 seconds; due that long after `from`.
// - `cron`: the standard five fields (minute hour day-of-month month day-of-week), read in UTC.
import { AppError } from "./errors.ts";

export const SCHEDULE_KINDS = ["once", "interval", "cron"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** An expression that is not a schedule: exit 1 on the CLI, 400 over the API, and nothing is written. */
export class InvalidScheduleError extends AppError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
  }
}

/** The shortest interval a job may repeat at. */
export const MIN_INTERVAL_MS = 60_000;

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** An interval in milliseconds (`15m` is 900000), or a refusal naming the form. Pure. */
export function parseInterval(expr: string): number {
  const m = /^(\d+)([smhd])$/.exec(expr.trim());
  if (!m) throw new InvalidScheduleError(`interval '${expr}' must be a whole number and a unit: 90s, 15m, 1h, 6h, 1d`);
  const ms = Number(m[1]) * UNIT_MS[m[2]!]!;
  if (!Number.isSafeInteger(ms) || ms < MIN_INTERVAL_MS) throw new InvalidScheduleError(`interval '${expr}' is shorter than the 60 second minimum`);
  return ms;
}

/** A `once` time as a Date: an ISO date and time (a bare date or impossible calendar date is refused). Pure. */
export function parseOnce(expr: string): Date {
  const raw = expr.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
  if (!m) {
    throw new InvalidScheduleError(`once '${expr}' must be an ISO timestamp, for example 2026-12-01T09:00:00Z`);
  }
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const maxDay = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (month < 1 || month > 12 || day < 1 || day > maxDay || Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59)) {
    throw new InvalidScheduleError(`once '${expr}' is not a real time`);
  }
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const at = new Date(withZone);
  if (Number.isNaN(at.getTime())) throw new InvalidScheduleError(`once '${expr}' is not a real time`);
  return at;
}

/** One cron field's allowed values, as a sorted set, plus whether it was `*` (for the day-of-month/day-of-week rule). */
interface CronField {
  values: Set<number>;
  star: boolean;
}

export interface CronSpec {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function cronValue(raw: string, name: string, min: number, max: number, names?: string[], nameBase = 0): number {
  const lower = raw.toLowerCase();
  if (names) {
    const i = names.indexOf(lower);
    if (i >= 0) return i + nameBase;
  }
  if (!/^\d+$/.test(raw)) throw new InvalidScheduleError(`cron ${name} '${raw}' is not a number`);
  const n = Number(raw);
  if (n < min || n > max) throw new InvalidScheduleError(`cron ${name} '${raw}' is outside ${min}-${max}`);
  return n;
}

function cronField(raw: string, name: string, min: number, max: number, names?: string[], nameBase = 0): CronField {
  const values = new Set<number>();
  let star = false;
  for (const part of raw.split(",")) {
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined || range === undefined || range === "") throw new InvalidScheduleError(`cron ${name} '${raw}' is not a cron field`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) throw new InvalidScheduleError(`cron ${name} step '${stepRaw}' must be a whole number above 0`);
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
      if (stepRaw === undefined) star = true;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || !a || !b) throw new InvalidScheduleError(`cron ${name} range '${range}' is not a range`);
      lo = cronValue(a, name, min, max, names, nameBase);
      hi = cronValue(b, name, min, max, names, nameBase);
      if (lo > hi) throw new InvalidScheduleError(`cron ${name} range '${range}' runs backwards`);
    } else {
      lo = cronValue(range, name, min, max, names, nameBase);
      hi = stepRaw === undefined ? lo : max;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, star };
}

/** The five cron fields, or a refusal naming the field that is wrong. Day-of-week 7 is Sunday, as 0 is. Pure. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") {
    throw new InvalidScheduleError(`cron '${expr}' must have 5 fields (minute hour day-of-month month day-of-week), got ${fields[0] === "" ? 0 : fields.length}`);
  }
  const [mi, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const dowField = cronField(dow, "day-of-week", 0, 7, DOW_NAMES);
  if (dowField.values.delete(7)) dowField.values.add(0);
  return {
    minute: cronField(mi, "minute", 0, 59),
    hour: cronField(h, "hour", 0, 23),
    dom: cronField(dom, "day-of-month", 1, 31),
    month: cronField(mon, "month", 1, 12, MONTH_NAMES, 1),
    dow: dowField,
  };
}

/** How far ahead a cron with no matching day is searched before it is refused (`0 0 30 2 *` never runs). */
const CRON_SEARCH_DAYS = 366 * 5;

/**
 * Whether a UTC day matches. As in cron: when both day fields are restricted, a day matching either runs;
 * when one is `*`, only the other one counts.
 */
function cronDayMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.month.values.has(d.getUTCMonth() + 1)) return false;
  const domOk = spec.dom.values.has(d.getUTCDate());
  const dowOk = spec.dow.values.has(d.getUTCDay());
  if (spec.dom.star && spec.dow.star) return true;
  if (spec.dom.star) return dowOk;
  if (spec.dow.star) return domOk;
  return domOk || dowOk;
}

/** The first minute strictly after `from` that the cron matches, in UTC, or null when none comes within 5 years. Pure. */
export function nextCronAfter(spec: CronSpec, from: Date): Date | null {
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const hours = [...spec.hour.values].sort((a, b) => a - b);
  const minutes = [...spec.minute.values].sort((a, b) => a - b);
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let i = 0; i < CRON_SEARCH_DAYS; i++) {
    if (cronDayMatches(spec, day)) {
      for (const h of hours) {
        for (const m of minutes) {
          const t = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m);
          if (t >= start.getTime()) return new Date(t);
        }
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return null;
}

/** The kind as a ScheduleKind, or a refusal. Pure. */
export function parseScheduleKind(raw: string): ScheduleKind {
  if ((SCHEDULE_KINDS as readonly string[]).includes(raw)) return raw as ScheduleKind;
  throw new InvalidScheduleError(`schedule kind must be one of ${SCHEDULE_KINDS.join("|")} (got '${raw}')`);
}

/**
 * When a job with this schedule is next due after `from`, as an ISO string. A `once` job is due at its own time,
 * past or future: `from` does not move it. An invalid expression throws InvalidScheduleError. Pure.
 */
export function computeNextRunAt(kind: ScheduleKind, expr: string, from: Date): string {
  if (kind === "once") return parseOnce(expr).toISOString();
  if (kind === "interval") return new Date(from.getTime() + parseInterval(expr)).toISOString();
  const next = nextCronAfter(parseCron(expr), from);
  if (!next) throw new InvalidScheduleError(`cron '${expr}' matches no day in the next 5 years`);
  return next.toISOString();
}

/** The expression as it is stored: trimmed, a `once` time normalized to UTC ISO, cron fields single-spaced. Pure. */
export function normalizeScheduleExpr(kind: ScheduleKind, expr: string): string {
  if (kind === "once") return parseOnce(expr).toISOString();
  if (kind === "cron") return expr.trim().split(/\s+/).join(" ");
  return expr.trim();
}

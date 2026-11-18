/**
 * Dashboard time display, in one fixed zone.
 *
 * Every timestamp the store holds is UTC ISO-8601 (`nowIso()`, Calendar `start_ts`, WhatsApp `ts`). The
 * dashboard shows South African time. The zone is FIXED, never the browser's or the server's own: SSR runs
 * on a UTC host and the browser in another zone, so a local-zone format renders differently on each side
 * and brings back the hydration mismatch.
 */
export const DISPLAY_TIME_ZONE = "Africa/Johannesburg";
/** Pinned with the zone: the default locale can differ between the server and the browser. */
export const DISPLAY_LOCALE = "en-GB";

const PARTS = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** A bare calendar date (all-day events, date columns). It has no time and no zone, so it never converts. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parts(ts: string): Record<string, string> | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const out: Record<string, string> = {};
  for (const p of PARTS.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "YYYY-MM-DD HH:MM" in South African time. Empty for null/empty; a bare date or unparseable input comes back unchanged. */
export function fmtDateTime(ts: string | null | undefined): string {
  if (!ts) return "";
  if (DATE_ONLY.test(ts)) return ts;
  const p = parts(ts);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : ts;
}

/** "HH:MM" in South African time. Empty for null/empty; a bare date or unparseable input comes back unchanged. */
export function fmtClock(ts: string | null | undefined): string {
  if (!ts) return "";
  if (DATE_ONLY.test(ts)) return ts;
  const p = parts(ts);
  return p ? `${p.hour}:${p.minute}` : ts;
}

/** "YYYY-MM-DD" of an instant in South African time. A bare date comes back unchanged. */
export function fmtDate(ts: string | null | undefined): string {
  if (!ts) return "";
  if (DATE_ONLY.test(ts)) return ts;
  const p = parts(ts);
  return p ? `${p.year}-${p.month}-${p.day}` : ts;
}

/** Today's date in South Africa, "YYYY-MM-DD". Not the runtime's date: a UTC server is a day behind from 00:00 to 02:00 SAST. */
export function saToday(now: Date = new Date()): string {
  return fmtDate(now.toISOString());
}

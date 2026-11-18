/**
 * South African time for the agenda and the journal's day windows. South Africa is UTC+2 all year (no
 * daylight saving), so a day there starts at 22:00Z the evening before. Stored event times are UTC ISO
 * (timed) or a bare YYYY-MM-DD (all-day).
 */
const SA_OFFSET_MS = 2 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** "HH:MM" of a UTC ISO instant in South African time. A bare date or unparseable input comes back unchanged. */
export function saClock(ts: string): string {
  if (DATE_ONLY.test(ts)) return ts;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return new Date(d.getTime() + SA_OFFSET_MS).toISOString().slice(11, 16);
}

/** The [from, to) UTC instants of the South African calendar day `date` (YYYY-MM-DD). PURE.
 *
 *  `from` = 00:00 SAST of that day and `to` = 00:00 SAST of the next. One lexical range then holds both stored
 *  shapes: a timed event (full ISO) falls in by instant, and an all-day event's bare `YYYY-MM-DD` sorts after
 *  the previous evening's `from` and before the next day's `to` only for that day. */
export function saDateBounds(date: string): { from: string; to: string } {
  const midnightUtc = Date.parse(`${date}T00:00:00.000Z`);
  return {
    from: new Date(midnightUtc - SA_OFFSET_MS).toISOString(),
    to: new Date(midnightUtc + DAY_MS - SA_OFFSET_MS).toISOString(),
  };
}

/** The South African calendar day containing the instant `now`, as [from, to) bounds. PURE. */
export function saDayBounds(now: Date): { from: string; to: string } {
  return saDateBounds(new Date(now.getTime() + SA_OFFSET_MS).toISOString().slice(0, 10));
}

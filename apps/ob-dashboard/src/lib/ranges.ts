// OS-176: the Models page's range editor, as pure steps over the rows being typed. A row's from and to stay the
// text in its boxes until a save, so a half-typed number is never lost; `rangesOf` turns them into numbers for the
// save, and the server (model-routes.ts) judges the set: a gap or an overlap comes back as the CLI's own refusal.

export interface DraftRange<T> {
  from: string;
  to: string;
  value: T;
}

export interface RangeOf<T> {
  from: number;
  to: number;
  value: T;
}

/** Rows to type into, from the ranges a view holds. Pure. */
export function draftsOf<R extends { from: number; to: number }, T>(ranges: readonly R[], value: (r: R) => T): DraftRange<T>[] {
  return ranges.map((r) => ({ from: String(r.from), to: String(r.to), value: value(r) }));
}

/** A box's text as a whole number, or null. Pure. */
export function wholeNumber(text: string): number | null {
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** Every row's from and to as whole numbers, or the refusal naming the first box that is not one. Pure. */
export function rangesOf<T>(rows: readonly DraftRange<T>[]): RangeOf<T>[] | string {
  const out: RangeOf<T>[] = [];
  for (const [i, r] of rows.entries()) {
    const from = wholeNumber(r.from);
    if (from === null) return `row ${i + 1}: from '${r.from}' is not a whole number`;
    const to = wholeNumber(r.to);
    if (to === null) return `row ${i + 1}: to '${r.to}' is not a whole number`;
    out.push({ from, to, value: r.value });
  }
  return out;
}

/**
 * Split row `i` at `at`: a-b becomes a-(at-1) and at-b, both with the row's value. `at` must be above the row's
 * from and no higher than its to, so both halves hold a score. Returns the new rows, or why it cannot. Pure.
 */
export function splitAt<T>(rows: readonly DraftRange<T>[], i: number, at: string): DraftRange<T>[] | string {
  const row = rows[i];
  if (!row) return `there is no row ${i + 1}`;
  const from = wholeNumber(row.from);
  const to = wholeNumber(row.to);
  if (from === null || to === null) return `row ${i + 1} is not a range of whole numbers yet`;
  const n = wholeNumber(at);
  if (n === null) return `split at '${at}' is not a whole number`;
  if (n <= from || n > to) {
    return from === to ? `row ${i + 1} holds one score, ${from}, so it cannot be split` : `split at ${n} must be from ${from + 1} to ${to}, so both halves hold a score`;
  }
  return [...rows.slice(0, i), { ...row, to: String(n - 1) }, { ...row, from: String(n) }, ...rows.slice(i + 1)];
}

/** Merge row `i` with the row after it: from of the first, to of the second, the first row's value. Pure. */
export function mergeNext<T>(rows: readonly DraftRange<T>[], i: number): DraftRange<T>[] | string {
  const row = rows[i];
  const next = rows[i + 1];
  if (!row || !next) return `row ${i + 1} has no row after it to merge with`;
  return [...rows.slice(0, i), { ...row, to: next.to }, ...rows.slice(i + 2)];
}

import { desc, eq } from "drizzle-orm";
import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { nowIso } from "../db.ts";
import { getCursorFor, setCursorFor } from "../settings.ts";
import type { Store } from "../db/store.ts";

// The "last standup" boundary (086/088): the moment of the last delivered standup. Generation covers
// activity SINCE it (so you don't re-report), and marking posted advances it to the end of the window that
// standup actually covered, i.e. its generation moment, not the posting moment (so a day off still leaves
// the next standup covering everything since your real last post). Generation never advances it.
export const STANDUP_CURSOR = "standup_last";

export async function lastStandupAt(store: Store): Promise<string | null> {
  return await getCursorFor(store, STANDUP_CURSOR);
}

/** Since when to generate — the last-standup boundary, else last 24h (first-ever run). */
export async function standupSince(store: Store): Promise<string> {
  return (await getCursorFor(store, STANDUP_CURSOR)) ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
}

// Standup store (086): the generated standup + the user's edit, one row/day. The scheduled skill run
// writes `generated_md` (save); the dashboard writes `edited_md` (set); posting marks it posted.
// Effective text = edited_md ?? generated_md.

export interface StandupRow {
  date: string;
  generated_md: string | null;
  edited_md: string | null;
  status: string; // generated | edited | posted
  generated_at: string | null;
  edited_at: string | null;
  posted_at: string | null;
}

/** The local calendar day (YYYY-MM-DD). Local, not UTC, so a 09:30-local run and the weekend guard
 *  always agree with the user's actual day (a UTC date flips a few hours early). */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function effectiveText(r: StandupRow | null): string | null {
  return r ? (r.edited_md ?? r.generated_md) : null;
}

/** Upsert today's generated standup. A regenerate resets the row (clears any prior edit/post). */
export async function saveGenerated(store: Store, date: string, md: string): Promise<void> {
  const at = nowIso();
  await store.q
    .insert(store.t.standup)
    .values({ date, generated_md: md, status: "generated", generated_at: at })
    .onConflictDoUpdate({
      target: store.t.standup.date,
      set: { generated_md: md, status: "generated", generated_at: at, edited_md: null, edited_at: null, posted_at: null },
    });
}

/** Save the user's edit (upsert — the surface can save even before a generation exists). */
export async function setEdited(store: Store, date: string, md: string): Promise<void> {
  const at = nowIso();
  await store.q
    .insert(store.t.standup)
    .values({ date, edited_md: md, status: "edited", edited_at: at })
    .onConflictDoUpdate({ target: store.t.standup.date, set: { edited_md: md, status: "edited", edited_at: at } });
}

/** Mark posted AND advance the last-standup boundary — this is the deliberate "I delivered it" action.
 *
 *  A standup carries ONE time (131): the moment its content was assembled. Posting is a status change,
 *  not a second timestamp, so `posted_at` and the boundary are resolved once and are always equal.
 *  That moment is `generated_at`, the end of the window the content actually covers: generate at 09:00,
 *  post at 14:00, and moving the boundary to 14:00 would drop the 09:00-14:00 work from both standups:
 *  out of the posted one, which was written before it happened, and out of the next one, which would
 *  start after it. Editing does NOT extend the window: an edit changes the words, not the period the
 *  content was assembled from, so `edited_at` is only the fallback for a row hand-written with no
 *  generation at all (`setEdited` upserts). Now is the last resort, since a fallback beats silently
 *  leaving the boundary unmoved. */
export async function markPosted(store: Store, date: string): Promise<boolean> {
  const rows = (await store.q
    .select({ generated_at: store.t.standup.generated_at, edited_at: store.t.standup.edited_at })
    .from(store.t.standup)
    .where(eq(store.t.standup.date, date))
    .limit(1)) as Array<{ generated_at: string | null; edited_at: string | null }>;
  const row = rows[0];
  if (!row) return false;
  const at = row.generated_at ?? row.edited_at ?? nowIso();
  await store.q
    .update(store.t.standup)
    .set({ status: "posted", posted_at: at })
    .where(eq(store.t.standup.date, date));
  await setCursorFor(store, STANDUP_CURSOR, at);
  return true;
}

export async function getStandup(store: Store, date: string): Promise<StandupRow | null> {
  const rows = (await store.q
    .select()
    .from(store.t.standup)
    .where(eq(store.t.standup.date, date))
    .limit(1)) as StandupRow[];
  return rows[0] ?? null;
}

export async function latestStandup(store: Store): Promise<StandupRow | null> {
  const rows = (await store.q
    .select()
    .from(store.t.standup)
    .orderBy(desc(store.t.standup.date))
    .limit(1)) as StandupRow[];
  return rows[0] ?? null;
}

/** Recent standups, newest-first — the "past standups" history (QW3). `limit` caps the list (default 30).
 *
 *  `standup.date` is the primary key, so it is NOT NULL and the DESC ordering cannot meet the
 *  NULLS-FIRST-on-Postgres / NULLS-LAST-on-SQLite split; it is also unique, so there are no ties to break. */
export async function listStandups(store: Store, opts: { limit?: number } = {}): Promise<StandupRow[]> {
  const limit = opts.limit ?? 30;
  return (await store.q
    .select()
    .from(store.t.standup)
    .orderBy(desc(store.t.standup.date))
    .limit(limit)) as StandupRow[];
}

async function readStdin(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

export async function cmdStandup(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  const store = ctx.store;
  const date = today();

  if (sub === "save") {
    const md = await readStdin();
    if (!md) throw new UsageError("ob standup save reads the standup markdown from stdin");
    await saveGenerated(store, date, md);
    print(`saved standup for ${date}`);
    return;
  }

  if (sub === "set") {
    const md = await readStdin();
    if (!md) throw new UsageError("ob standup set reads the edited markdown from stdin");
    await setEdited(store, date, md);
    print(`updated standup for ${date}`);
    return;
  }

  if (sub === "posted") {
    print((await markPosted(store, date)) ? `marked ${date} posted` : `no standup for ${date}`);
    return;
  }

  if (sub === "latest" || sub === undefined) {
    const r = await latestStandup(store);
    if (ctx.mode === "json") {
      print(JSON.stringify(r));
      return;
    }
    print(r ? (effectiveText(r) ?? "(empty)") : "no standup yet");
    return;
  }

  throw new UsageError(`unknown standup subcommand '${sub}' (save|set|latest|posted)`);
}

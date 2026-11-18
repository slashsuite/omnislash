import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { saveGenerated, setEdited, markPosted, getStandup, latestStandup, listStandups, effectiveText, lastStandupAt, standupSince } from "../../../apps/cli/src/commands/standup.ts";
import { nowIso } from "../../../apps/cli/src/db.ts";
import { orm } from "../../../apps/cli/src/db/orm.ts";
import { item, standup } from "../../../apps/cli/src/db/schema.ts";

/** Backdate a stored standup's timestamps, so a test can post one that was generated hours earlier
 *  without waiting for the clock. */
function stampTimes(db: Database, date: string, times: { generated_at?: string | null; edited_at?: string | null }): void {
  orm(db).update(standup).set(times).where(eq(standup.date, date)).run();
}

function closeItemAt(db: Database, id: string, at: string): void {
  orm(db).insert(item).values({ id, type: "task", title: `closed at ${at}`, status: "done", created_at: at, updated_at: at, closed_at: at }).run();
}

describe("standup store (086)", () => {
  test("save → edit → posted round-trip; effective text = edit ?? generated", async () => {
    const db = freshDb();
    expect((await latestStandup(sqliteStoreFor(db)))).toBeNull();

    (await saveGenerated(sqliteStoreFor(db), "2026-07-18", "generated body"));
    let r = (await getStandup(sqliteStoreFor(db), "2026-07-18"))!;
    expect(r.status).toBe("generated");
    expect(r.generated_md).toBe("generated body");
    expect(r.edited_md).toBeNull();
    expect(effectiveText(r)).toBe("generated body");
    expect(r.generated_at).toBeTruthy();

    (await setEdited(sqliteStoreFor(db), "2026-07-18", "my edit"));
    r = (await getStandup(sqliteStoreFor(db), "2026-07-18"))!;
    expect(r.status).toBe("edited");
    expect(r.generated_md).toBe("generated body"); // generation preserved
    expect(effectiveText(r)).toBe("my edit"); // edit wins
    expect(r.edited_at).toBeTruthy();

    expect((await markPosted(sqliteStoreFor(db), "2026-07-18"))).toBe(true);
    expect((await getStandup(sqliteStoreFor(db), "2026-07-18"))!.status).toBe("posted");
    expect((await markPosted(sqliteStoreFor(db), "2026-07-19"))).toBe(false); // no row for that day
  });

  test("regenerate resets a prior edit; latest picks the newest date", async () => {
    const db = freshDb();
    (await saveGenerated(sqliteStoreFor(db), "2026-07-17", "old day"));
    (await saveGenerated(sqliteStoreFor(db), "2026-07-18", "gen v1"));
    (await setEdited(sqliteStoreFor(db), "2026-07-18", "edited v1"));
    (await saveGenerated(sqliteStoreFor(db), "2026-07-18", "gen v2")); // regenerate same day
    const r = (await getStandup(sqliteStoreFor(db), "2026-07-18"))!;
    expect(r.generated_md).toBe("gen v2");
    expect(r.edited_md).toBeNull(); // edit cleared on regenerate
    expect(r.status).toBe("generated");

    expect((await latestStandup(sqliteStoreFor(db)))!.date).toBe("2026-07-18"); // newest by date
  });

  test("set can precede a generation (upsert)", async () => {
    const db = freshDb();
    (await setEdited(sqliteStoreFor(db), "2026-07-18", "hand-written"));
    const r = (await getStandup(sqliteStoreFor(db), "2026-07-18"))!;
    expect(r.generated_md).toBeNull();
    expect(effectiveText(r)).toBe("hand-written");
  });

  test("markPosted advances the since-last-standup boundary; save does not advance it", async () => {
    const db = freshDb();
    expect((await lastStandupAt(sqliteStoreFor(db)))).toBeNull();
    // no boundary yet → standupSince falls back to ~24h ago (a real time in the past)
    expect(new Date((await standupSince(sqliteStoreFor(db)))).getTime()).toBeLessThanOrEqual(Date.now());

    (await saveGenerated(sqliteStoreFor(db), "2026-07-18", "draft"));
    expect((await lastStandupAt(sqliteStoreFor(db)))).toBeNull(); // generating/saving must NOT advance the boundary

    (await markPosted(sqliteStoreFor(db), "2026-07-18")); // the deliberate "delivered" action advances it
    const boundary = (await lastStandupAt(sqliteStoreFor(db)))!;
    expect(boundary).toBeTruthy();
    expect((await standupSince(sqliteStoreFor(db)))).toBe(boundary);
  });

  test("the boundary is the standup's generation moment, and posted_at is the same one time (131)", async () => {
    const db = freshDb();
    const T1 = "2026-07-18T09:00:00.000Z";
    (await saveGenerated(sqliteStoreFor(db), "2026-07-18", "draft"));
    stampTimes(db, "2026-07-18", { generated_at: T1 });

    const before = nowIso();
    expect((await markPosted(sqliteStoreFor(db), "2026-07-18"))).toBe(true);

    expect((await lastStandupAt(sqliteStoreFor(db)))).toBe(T1); // NOT the wall-clock posting moment
    const r = (await getStandup(sqliteStoreFor(db), "2026-07-18"))!;
    expect(r.status).toBe("posted");
    expect(r.posted_at).toBe(T1); // one time per standup: posted_at and the boundary agree, deliberately
    expect(r.posted_at! < before).toBe(true); // and it is the generation moment, not now
  });

  test("work done between generation and posting lands in the NEXT standup, not nowhere (131)", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const T1 = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const between = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    (await saveGenerated(store, "2026-07-18", "draft written at T1"));
    stampTimes(db, "2026-07-18", { generated_at: T1 });
    closeItemAt(db, "itm-between", between); // finished after the draft was assembled, before it was posted

    (await markPosted(store, "2026-07-18"));

    // The next window opens at the GENERATION moment, not at the (later) posting moment, so the work
    // done in between is inside it rather than falling into the gap between two standups (131).
    const since = await standupSince(store);
    expect(since).toBe(T1);
    expect(between > since).toBe(true);
  });

  test("an edited standup with no generation falls back to edited_at (131)", async () => {
    const db = freshDb();
    const T1 = "2026-07-18T09:00:00.000Z";
    (await setEdited(sqliteStoreFor(db), "2026-07-18", "hand-written, never generated"));
    stampTimes(db, "2026-07-18", { edited_at: T1 });

    expect((await markPosted(sqliteStoreFor(db), "2026-07-18"))).toBe(true);
    expect((await getStandup(sqliteStoreFor(db), "2026-07-18"))!.generated_at).toBeNull();
    expect((await lastStandupAt(sqliteStoreFor(db)))).toBe(T1);
    expect((await getStandup(sqliteStoreFor(db), "2026-07-18"))!.posted_at).toBe(T1);
  });

  test("an edit does not extend the window, so a generated-then-edited standup still uses generated_at (131)", async () => {
    const db = freshDb();
    const generatedAt = "2026-07-18T09:00:00.000Z";
    const editedAt = "2026-07-18T13:00:00.000Z";
    (await saveGenerated(sqliteStoreFor(db), "2026-07-18", "draft"));
    (await setEdited(sqliteStoreFor(db), "2026-07-18", "my edit"));
    stampTimes(db, "2026-07-18", { generated_at: generatedAt, edited_at: editedAt });

    (await markPosted(sqliteStoreFor(db), "2026-07-18"));
    expect((await lastStandupAt(sqliteStoreFor(db)))).toBe(generatedAt);
    expect((await getStandup(sqliteStoreFor(db), "2026-07-18"))!.posted_at).toBe(generatedAt);
  });

  test("re-posting is idempotent: neither the boundary nor posted_at creeps forward (131)", async () => {
    const db = freshDb();
    const T1 = "2026-07-18T09:00:00.000Z";
    (await saveGenerated(sqliteStoreFor(db), "2026-07-18", "draft"));
    stampTimes(db, "2026-07-18", { generated_at: T1 });

    (await markPosted(sqliteStoreFor(db), "2026-07-18"));
    const boundary = (await lastStandupAt(sqliteStoreFor(db)));
    const postedAt = (await getStandup(sqliteStoreFor(db), "2026-07-18"))!.posted_at;

    expect((await markPosted(sqliteStoreFor(db), "2026-07-18"))).toBe(true);
    expect((await lastStandupAt(sqliteStoreFor(db)))).toBe(boundary);
    expect((await getStandup(sqliteStoreFor(db), "2026-07-18"))!.posted_at).toBe(postedAt);
    expect(boundary).toBe(T1);
  });

  test("listStandups returns the history newest-first, capped by limit (QW3)", async () => {
    const db = freshDb();
    expect((await listStandups(sqliteStoreFor(db)))).toEqual([]); // empty store

    (await saveGenerated(sqliteStoreFor(db), "2026-07-16", "gen 16"));
    (await saveGenerated(sqliteStoreFor(db), "2026-07-17", "gen 17"));
    (await setEdited(sqliteStoreFor(db), "2026-07-17", "edit 17"));
    (await saveGenerated(sqliteStoreFor(db), "2026-07-18", "gen 18"));

    const all = (await listStandups(sqliteStoreFor(db)));
    expect(all.map((r) => r.date)).toEqual(["2026-07-18", "2026-07-17", "2026-07-16"]); // newest-first
    // rows carry the raw generated/edited text so the caller can compute effective text (edit wins)
    const jul17 = all.find((r) => r.date === "2026-07-17")!;
    expect(effectiveText(jul17)).toBe("edit 17");

    // limit caps the list (still newest-first)
    expect((await listStandups(sqliteStoreFor(db), { limit: 2 })).map((r) => r.date)).toEqual(["2026-07-18", "2026-07-17"]);
  });
});

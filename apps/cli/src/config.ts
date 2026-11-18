// ob 337: the config table through ob 324's store seam.
//
// Same two conventions as items.ts: every function takes `Database | Store` and normalises with asStore,
// so a signature WIDENS rather than changes; and every function is async with every builder AWAITED,
// because `.all()` / `.get()` / `.run()` are the sqlite dialect's synchronous terminators and do not
// exist on pg-core.
//
// WHY settings.ts's `setting()` DID NOT COME WITH IT. `setting()` has ~90 call sites reaching through
// whatsapp, net, cert, credentials, spinoff and the connectors -- none of which is ported, and all of
// which would have to become async in this one change to follow it. So settings.ts keeps a SYNCHRONOUS,
// explicitly sqlite-only read of this same table for those callers, and `settingFor()` is the async
// store-aware form a ported caller uses. That is not two sources of truth for the value: it is one table
// read two ways, and the sync way is only reachable from a handle, which in postgres mode no unported
// command ever gets (db.ts's guard refuses to open one).
import type { Database } from "bun:sqlite";
import { asc, eq, sql } from "drizzle-orm";
import { asStore, type Store } from "./db/store.ts";

export async function getConfig(db: Database | Store, key: string): Promise<string | null> {
  const store = asStore(db);
  const rows = await store.q
    .select({ value: store.t.config.value })
    .from(store.t.config)
    .where(eq(store.t.config.key, key))
    .limit(1);
  return rows[0] ? rows[0].value : null;
}

export async function setConfig(db: Database | Store, key: string, value: string): Promise<void> {
  const store = asStore(db);
  await store.q
    .insert(store.t.config)
    .values({ key, value })
    .onConflictDoUpdate({ target: store.t.config.key, set: { value: sql`excluded.value` } });
}

export async function deleteConfig(db: Database | Store, key: string): Promise<void> {
  const store = asStore(db);
  await store.q.delete(store.t.config).where(eq(store.t.config.key, key));
}

export async function allConfig(
  db: Database | Store,
): Promise<Array<{ key: string; value: string | null }>> {
  const store = asStore(db);
  return await store.q
    .select({ key: store.t.config.key, value: store.t.config.value })
    .from(store.t.config)
    .orderBy(asc(store.t.config.key));
}

export async function getFocusProject(db: Database | Store): Promise<string | null> {
  return getConfig(db, "focus_project");
}

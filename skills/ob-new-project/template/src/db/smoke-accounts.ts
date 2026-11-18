import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { accounts } from "./schema";

/**
 * The fixed smoke fixtures. Production smoke tests sign in as these and nothing else; the
 * password lives in the secret store, never here. Fixed ids make the seed idempotent.
 */
export const SMOKE_ACCOUNTS = [{ id: "smoke-account-1", email: "smoke+1@smoke.invalid" }] as const;

type Db = BaseSQLiteDatabase<"async", unknown>;

/** Safe to run on every deploy: re-running inserts nothing. */
export async function seedSmokeAccounts(db: Db): Promise<void> {
  await db
    .insert(accounts)
    .values(SMOKE_ACCOUNTS.map((a) => ({ ...a, createdAt: new Date(0), isSmoke: true })))
    .onConflictDoNothing();
}

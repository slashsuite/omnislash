import { count } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { accounts } from "./schema";
import { real } from "./synthetic";

type Db = BaseSQLiteDatabase<"async", unknown>;

/** The first dashboard number. Every report query filters with `real()`, as this one does. */
export async function accountCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(accounts).where(real(accounts.isSmoke));
  return row?.n ?? 0;
}

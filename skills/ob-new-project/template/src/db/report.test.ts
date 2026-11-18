import { describe, expect, test } from "vitest";
import { accountCount } from "./report";
import { accounts } from "./schema";
import { seedSmokeAccounts } from "./smoke-accounts";
import { testDb } from "./test-db";

describe("smoke isolation", () => {
  test("a smoke run leaves the dashboard numbers unchanged and accumulates nothing", async () => {
    const db = testDb();
    await db
      .insert(accounts)
      .values({ id: "a1", email: "real@example.com", createdAt: new Date() });
    const before = await accountCount(db);

    await seedSmokeAccounts(db);
    await seedSmokeAccounts(db);

    expect(await accountCount(db)).toBe(before);
    expect(await db.select().from(accounts)).toHaveLength(2);
  });
});

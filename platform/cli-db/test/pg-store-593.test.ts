import { describe, expect, test } from "bun:test";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { freshPgDatabase } from "../../../apps/cli/test/pg/harness.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(3);

describe("ob 593: dashboard open does not migrate", () => {
	test(
		"migrate: false opens without applying the chain",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			let store: Store | undefined;
			try {
				store = await openStore({
					kind: "postgres",
					connection: db.options as unknown as Record<string, unknown>,
					migrate: false,
				});
				const rows = (await db.sql.unsafe(
					`SELECT to_regclass('public.__drizzle_migrations') AS r`,
				)) as { r: string | null }[];
				expect(rows[0]?.r).toBeNull();
			} finally {
				await store?.close();
				await db.drop();
			}
		},
		PG_BUDGET,
	);
});

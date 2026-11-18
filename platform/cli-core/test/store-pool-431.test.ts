// ob 431: every postgresStore SQL client is capped at max: 3.
//
// Bun's default pool is ~10. The database host's max_connections is 50. Four live processes at the default
// exhaust the cluster (53300). This file asserts the options object, by injecting the constructor,
// and never opens a database.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createPostgresSqlClient,
	PG_POOL_IDLE_TIMEOUT_S,
	PG_POOL_MAX,
	postgresIdleTimeoutForCommand,
	postgresPoolIdleTimeout,
	postgresPoolMax,
	postgresPoolOptions,
} from "../../../apps/cli/src/db/store.ts";

const STORE_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/cli/src/db/store.ts");
const CLI_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/cli/src/cli.ts");

class FakeSQL {
	readonly args: unknown[];
	constructor(connection: string, options?: { max: number; idleTimeout: number }) {
		this.args = options === undefined ? [connection] : [connection, options];
	}
	async end(): Promise<void> {}
}

describe("ob 431: postgres pool cap", () => {
	test("the cap is 3, because that is the number the comment and the ticket name", () => {
		expect(PG_POOL_MAX).toBe(3);
	});

	test("a missing or unusable request becomes the cap", () => {
		expect(postgresPoolMax()).toBe(3);
		expect(postgresPoolMax(undefined)).toBe(3);
		expect(postgresPoolMax(0)).toBe(3);
		expect(postgresPoolMax(-1)).toBe(3);
		expect(postgresPoolMax(Number.NaN)).toBe(3);
		expect(postgresPoolMax("10")).toBe(3);
	});

	test("an explicit request above the cap is cut down, not raised past it", () => {
		expect(postgresPoolMax(10)).toBe(3);
		expect(postgresPoolMax(4)).toBe(3);
	});

	test("an explicit smaller request is kept (the test harness pins max: 2 for txn)", () => {
		expect(postgresPoolMax(2)).toBe(2);
		expect(postgresPoolMax(1)).toBe(1);
	});

	test("a url is constructed as new SQL(url, { max: 3, idleTimeout: 30, connectionTimeout: 10 })", () => {
		const client = createPostgresSqlClient(FakeSQL, "postgres://ob@host:5432/omnislash");
		expect(client).toBeInstanceOf(FakeSQL);
		expect(client.args).toEqual(["postgres://ob@host:5432/omnislash", { max: 3, idleTimeout: 30, connectionTimeout: 10 }]);
	});

	test("a connection object is constructed with max: 3 and idleTimeout merged in", () => {
		const client = createPostgresSqlClient(FakeSQL, {
			adapter: "postgres",
			path: "/tmp/s",
			database: "acme",
		});
		expect(client.args).toEqual([
			{ adapter: "postgres", path: "/tmp/s", database: "acme", max: 3, idleTimeout: 30, connectionTimeout: 10 },
		]);
	});

	test("a connection object that already asked for 10 is still capped at 3", () => {
		const client = createPostgresSqlClient(FakeSQL, { adapter: "postgres", max: 10 });
		expect(client.args).toEqual([{ adapter: "postgres", max: 3, idleTimeout: 30, connectionTimeout: 10 }]);
	});

	test("a connection object that already asked for 2 keeps 2", () => {
		const client = createPostgresSqlClient(FakeSQL, { adapter: "postgres", max: 2 });
		expect(client.args).toEqual([{ adapter: "postgres", max: 2, idleTimeout: 30, connectionTimeout: 10 }]);
	});

	test("idle-out is 30s and is not overridable (ob 401)", () => {
		expect(PG_POOL_IDLE_TIMEOUT_S).toBe(30);
		expect(postgresPoolOptions()).toEqual({ max: 3, idleTimeout: 30, connectionTimeout: 10 });
		expect(postgresPoolOptions(2)).toEqual({ max: 2, idleTimeout: 30, connectionTimeout: 10 });
		const client = createPostgresSqlClient(FakeSQL, { adapter: "postgres", idleTimeout: 1, max: 2 });
		expect(client.args).toEqual([{ adapter: "postgres", max: 2, idleTimeout: 30, connectionTimeout: 10 }]);
	});

	test("postgresStore constructs its client through the helper, so a bypass cannot bring the 10-default back", () => {
		const src = readFileSync(STORE_SRC, "utf8");
		const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		expect(code).toContain("createPostgresSqlClient(SQL, connection, idleTimeout)");
		expect(code).not.toContain("new SQL(connection as string)");
	});
});

describe("ob 594: oneshot CLI disables postgres idle-out", () => {
	test("only 0 disables it; a connection object still cannot sneak a different timeout", () => {
		expect(postgresPoolIdleTimeout(0)).toBe(0);
		expect(postgresPoolIdleTimeout()).toBe(30);
		expect(postgresPoolIdleTimeout(1)).toBe(30);
		expect(postgresPoolIdleTimeout(600)).toBe(30);
		expect(postgresPoolOptions(undefined, 0)).toEqual({ max: 3, idleTimeout: 0, connectionTimeout: 10 });
		const sneaked = createPostgresSqlClient(FakeSQL, { adapter: "postgres", idleTimeout: 1, max: 2 });
		expect(sneaked.args).toEqual([{ adapter: "postgres", max: 2, idleTimeout: 30, connectionTimeout: 10 }]);
	});

	test("an explicit 0 reaches Bun as idleTimeout: 0", () => {
		const client = createPostgresSqlClient(FakeSQL, "postgres://ob@host:5432/omnislash", 0);
		expect(client.args).toEqual(["postgres://ob@host:5432/omnislash", { max: 3, idleTimeout: 0, connectionTimeout: 10 }]);
	});

	test("ob web keeps the 30s idle-out; every other command disables it", () => {
		expect(postgresIdleTimeoutForCommand("web")).toBe(PG_POOL_IDLE_TIMEOUT_S);
		expect(postgresIdleTimeoutForCommand("whatsapp")).toBe(0);
		expect(postgresIdleTimeoutForCommand("cal")).toBe(0);
		expect(postgresIdleTimeoutForCommand("gmail")).toBe(0);
	});

	test("cli.ts opens the postgres store with the per-command idle-out, so a bypass cannot bring 30s back onto whatsapp sync", () => {
		const src = readFileSync(CLI_SRC, "utf8");
		const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		expect(code).toContain("commandStore(db, { idleTimeout: postgresIdleTimeoutForCommand(command) })");
	});
});

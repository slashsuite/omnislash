// ob 1616: every call that can hang has a bounded wait that names itself.
//
// 2026-10-20: omnislash-web's Bun SQL pool leaked slots and every write hung 43 minutes with no error.
// These tests inject the thing that hangs (a store thunk, a transport, a promise) so no database and no
// network is involved: the assertion is that a never-answering dependency becomes a named error, fast.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CallTimeoutError, timeoutFromEnv, withDeadline } from "../../../apps/cli/src/deadline.ts";
import { ApiClient, ApiError, type ApiRequest } from "../../../apps/cli/src/api/client.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX, SLOW_ROUTE_TIMEOUT_FACTOR, apiTimeoutFor, type ObApiErrorBody } from "../../../apps/cli/src/api/contract.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";

const never = <T>(): Promise<T> => new Promise<T>(() => {});

describe("withDeadline (ob 1616)", () => {
	test("a call that never settles rejects with the call name and the budget", async () => {
		const err = await withDeadline("store txn 'close item'", 20, never).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CallTimeoutError);
		expect((err as CallTimeoutError).message).toBe("store txn 'close item' timed out after 20ms");
		expect((err as CallTimeoutError).call).toBe("store txn 'close item'");
		expect((err as CallTimeoutError).ms).toBe(20);
	});

	test("a call that settles in time is passed through, value and rejection both", async () => {
		expect(await withDeadline("fast", 1_000, async () => 7)).toBe(7);
		await expect(withDeadline("boom", 1_000, async () => Promise.reject(new Error("real failure")))).rejects.toThrow(
			"real failure",
		);
	});

	test("the loser's later rejection does not escape as an unhandled rejection", async () => {
		let rejectLate: (e: Error) => void = () => {};
		const late = new Promise<never>((_, reject) => {
			rejectLate = reject;
		});
		await expect(withDeadline("late", 10, () => late)).rejects.toBeInstanceOf(CallTimeoutError);
		rejectLate(new Error("too late")); // would crash the test run if nobody handled it
		await new Promise((r) => setTimeout(r, 10));
	});

	test("onTimeout fires so a cancellable caller can abort", async () => {
		let aborted = false;
		await withDeadline("cancellable", 10, never, () => {
			aborted = true;
		}).catch(() => {});
		expect(aborted).toBe(true);
	});

	test("timeoutFromEnv takes a positive integer and otherwise falls back", () => {
		expect(timeoutFromEnv("X", 5, { X: "250" })).toBe(250);
		for (const bad of ["", "0", "-3", "1.5", "soon", undefined]) {
			expect(timeoutFromEnv("X", 5, { X: bad })).toBe(5);
		}
	});
});

describe("ApiClient deadline (ob 1616)", () => {
	const make = (transport: (req: ApiRequest) => Promise<{ status: number; body: string }>) =>
		new ApiClient({ base: "https://ob.example", token: "tok-secret-value", transport, timeoutMs: 20 });

	test("a transport that never answers fails with the call, the budget, and 'timed out' (not 'could not reach')", async () => {
		const client = make(() => never());
		const err = await client.next().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		const message = (err as ApiError).message;
		expect(message).toContain("GET /next");
		expect(message).toContain("within 20ms");
		expect(message).toContain("timed out");
		expect(message).not.toContain("could not reach");
		expect(message).not.toContain("tok-secret-value");
	});

	test("the request's AbortSignal fires on timeout, so a real fetch tears its socket down", async () => {
		let signal: AbortSignal | undefined;
		const client = make((req) => {
			signal = req.signal;
			return never();
		});
		await client.next().catch(() => {});
		expect(signal?.aborted).toBe(true);
	});
});

describe("slow routes get a longer budget on both ends (ob 1616)", () => {
	test("an ingest or live check is not cut at the ordinary deadline; everything else is", () => {
		for (const route of ["/gmail/sync", "/cal/sync", "/sync", "/creds/check", "/sync?backfill=1", "/gmail/sync/"]) {
			expect(apiTimeoutFor(route, 100)).toBe(100 * SLOW_ROUTE_TIMEOUT_FACTOR);
		}
		for (const route of ["/next", "/items", "/items/42/close", "/syncing"]) {
			expect(apiTimeoutFor(route, 100)).toBe(100);
		}
	});
});

describe("ob API request deadline (ob 1616)", () => {
	const TOKEN = "a-test-bearer-token-that-is-long-enough";
	const api = (store: () => Promise<Store>, requestTimeoutMs = 20) =>
		createObApi({
			store,
			requestTimeoutMs,
			token: () => ({ token: TOKEN, path: "/nowhere", reason: null, message: null }),
		});
	const get = (handler: (req: Request) => Promise<Response>, path: string) =>
		handler(new Request(`http://api-host.local${OB_API_PREFIX}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }));

	test("a store that never opens becomes a 504 'timeout' naming the call and the budget", async () => {
		const res = await get(api(() => never()), "/next");
		expect(res.status).toBe(504);
		const body = (await res.json()) as ObApiErrorBody;
		expect(body.error.code).toBe("timeout");
		expect(body.error.message).toContain(`GET ${OB_API_PREFIX}/next`);
		expect(body.error.message).toContain("20ms");
	});
});

describe("postgres store calls are bounded (ob 1616)", () => {
	// No pg here (no live DB in tests): the Postgres store is only constructible against a server, so the
	// guard is on the source, the same way store-pool-431 guards the pool options.
	const src = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "../../../apps/cli/src/db/store.ts"),
		"utf8",
	);

	test("txn and notify on the postgres store both run under withDeadline", () => {
		expect(src).toContain("withDeadline(`store txn '${what}'`, callTimeoutMs");
		expect(src).toContain("withDeadline(`store notify '${channel}'`, callTimeoutMs");
	});
});

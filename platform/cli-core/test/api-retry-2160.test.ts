import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	API_RETRY_DEFAULT_MS,
	ApiClient,
	ApiError,
	isConnectionRefused,
	isConnectionReset,
	retryMsFromEnv,
	type ApiRetry,
	type ApiTransport,
} from "../../../apps/cli/src/api/client.ts";

// OB-2160: every live deploy restarts omnislash-web and the API refuses connections for that moment. The client
// rides it out: a refused connection is retried for any method, a reset only for a GET, a timeout never, all
// within one budget. A fake clock and sleep, so nothing here waits; the one real fetch is to a closed loopback
// port, which pins what Bun actually throws for a refused connection.

const BASE = "https://ob.example.test";
const TOKEN = "test-token-2160";

function refused(): Error {
	return Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
}
function reset(): Error {
	return Object.assign(new TypeError("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
}

/** A fake clock that moves only when the client sleeps. */
function clock(totalMs = API_RETRY_DEFAULT_MS): { retry: ApiRetry; sleeps: number[]; warnings: string[] } {
	let t = 0;
	const sleeps: number[] = [];
	const warnings: string[] = [];
	return {
		sleeps,
		warnings,
		retry: {
			totalMs,
			now: () => t,
			sleep: async (ms) => {
				sleeps.push(ms);
				t += ms;
			},
			warn: (line) => warnings.push(line),
		},
	};
}

/** A transport that throws each queued error once, then answers 200 with `body`. */
function flaky(errors: Array<() => unknown>, body: unknown = { ok: true }): { transport: ApiTransport; calls: string[] } {
	const calls: string[] = [];
	const transport: ApiTransport = async (req) => {
		calls.push(req.method);
		const next = errors.shift();
		if (next) throw next();
		return { status: 200, body: JSON.stringify(body) };
	};
	return { transport, calls };
}

describe("the refused-connection mapping is pinned on a real fetch (OB-2160)", () => {
	test("a fetch to a closed local port throws what isConnectionRefused treats as refused", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
		const port = server.port;
		server.stop(true);
		let caught: unknown;
		try {
			await fetch(`http://127.0.0.1:${port}/`);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		// OB-2291: Bun can report a refused connect as either spelling (CI once saw ECONNREFUSED in this test), so pin the set, not one.
		expect(["ConnectionRefused", "ECONNREFUSED"]).toContain((caught as { code?: string }).code as string);
		expect(isConnectionRefused(caught)).toBe(true);
		expect(isConnectionReset(caught)).toBe(false);
	});

	test("a connection the server closes mid-request is a reset, not refused", async () => {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(s) {
					s.end();
				},
				data() {},
			},
		});
		let caught: unknown;
		try {
			await fetch(`http://127.0.0.1:${listener.port}/`, { method: "POST", body: "x" });
		} catch (err) {
			caught = err;
		} finally {
			listener.stop(true);
		}
		expect(isConnectionRefused(caught)).toBe(false);
		expect(isConnectionReset(caught)).toBe(true);
	});

	test("the real fetch transport keeps that code, so the full client retries a closed port and then fails as unreachable", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
		const port = server.port;
		server.stop(true);
		// The real fetchTransport (no transport option) with a fake clock: the port stays closed, so every
		// attempt is a real refused fetch until the 1s budget is spent.
		const c = clock(1000);
		const client = new ApiClient({ base: `http://127.0.0.1:${port}`, token: TOKEN, retry: c.retry });
		const err = await client.leases().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).unreachable).toBe(true);
		expect((err as ApiError).message).toContain("could not reach the ob API");
		expect(c.sleeps).toEqual([500, 500]);
		expect(c.warnings).toHaveLength(1);
	});
});

describe("the client rides out a short outage (OB-2160)", () => {
	test("a refused GET is retried with backoff and then answers, printing one line", async () => {
		const c = clock();
		const t = flaky([refused, refused], { leases: [] });
		const client = new ApiClient({ base: BASE, token: TOKEN, transport: t.transport, retry: c.retry });
		const res = await client.leases();
		expect(res).toEqual({ leases: [] } as never);
		expect(t.calls).toEqual(["GET", "GET", "GET"]);
		expect(c.sleeps).toEqual([500, 1000]);
		expect(c.warnings).toEqual([`ob API at ${BASE} refused the connection, retrying for up to 30s (a deploy restarts it)`]);
	});

	test("a refused POST is retried too: nothing was sent (ob secret get is a POST)", async () => {
		const c = clock();
		const t = flaky([refused], { name: "github", value: "v" });
		const client = new ApiClient({ base: BASE, token: TOKEN, transport: t.transport, retry: c.retry });
		await client.readSecret({ name: "github" } as never);
		expect(t.calls).toEqual(["POST", "POST"]);
		expect(c.warnings).toHaveLength(1);
	});

	test("a reset on a POST is not retried: the server may have seen it", async () => {
		const c = clock();
		const t = flaky([reset]);
		const client = new ApiClient({ base: BASE, token: TOKEN, transport: t.transport, retry: c.retry });
		const err = await client.sweepLeases().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).message).toContain("could not reach the ob API");
		expect(t.calls).toEqual(["POST"]);
		expect(c.sleeps).toEqual([]);
		expect(c.warnings).toEqual([]);
	});

	test("a reset on a GET is retried", async () => {
		const c = clock();
		const t = flaky([reset], { leases: [] });
		const client = new ApiClient({ base: BASE, token: TOKEN, transport: t.transport, retry: c.retry });
		await client.leases();
		expect(t.calls).toEqual(["GET", "GET"]);
		expect(c.warnings[0]).toContain("dropped the connection");
	});

	test("a timeout (a hung server, the real deadline) is never retried", async () => {
		const c = clock();
		let calls = 0;
		const transport: ApiTransport = () => {
			calls += 1;
			return new Promise(() => {});
		};
		const client = new ApiClient({ base: BASE, token: TOKEN, transport, timeoutMs: 10, retry: c.retry });
		const err = await client.leases().catch((e: unknown) => e);
		expect((err as ApiError).message).toContain("timed out, not unreachable");
		expect(calls).toBe(1);
	});

	test("a DNS-style error with no code is not retried", async () => {
		const c = clock();
		const t = flaky([() => new Error("getaddrinfo ENOTFOUND ob.example.test")]);
		const client = new ApiClient({ base: BASE, token: TOKEN, transport: t.transport, retry: c.retry });
		await client.leases().catch(() => {});
		expect(t.calls).toEqual(["GET"]);
	});

	test("retries stop at the 30s budget with the original error", async () => {
		const c = clock();
		const t = flaky(Array.from({ length: 100 }, () => refused));
		const client = new ApiClient({ base: BASE, token: TOKEN, transport: t.transport, retry: c.retry });
		const err = await client.leases().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).unreachable).toBe(true);
		expect((err as ApiError).message).toContain("Unable to connect");
		// 0.5 + 1 + 2 + 4 + 4 ... capped at 4s, the last sleep trimmed to what is left of 30s.
		expect(c.sleeps.slice(0, 5)).toEqual([500, 1000, 2000, 4000, 4000]);
		expect(c.sleeps.every((ms) => ms <= 4000)).toBe(true);
		expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(30_000);
		expect(c.warnings).toHaveLength(1);
	});

	test("one client prints the line once, however many calls retry", async () => {
		const c = clock();
		const t = flaky([refused, refused], { leases: [] });
		const client = new ApiClient({ base: BASE, token: TOKEN, transport: t.transport, retry: c.retry });
		await client.leases();
		await client.leases().catch(() => {});
		expect(c.warnings).toHaveLength(1);
	});

	test("OB_API_RETRY_MS: 0 turns it off, unset or junk is the 30s default", () => {
		expect(retryMsFromEnv({ OB_API_RETRY_MS: "0" })).toBe(0);
		expect(retryMsFromEnv({ OB_API_RETRY_MS: "5000" })).toBe(5000);
		expect(retryMsFromEnv({})).toBe(30_000);
		expect(retryMsFromEnv({ OB_API_RETRY_MS: "soon" })).toBe(30_000);
		expect(retryMsFromEnv({ OB_API_RETRY_MS: "-1" })).toBe(30_000);
	});

	test("OB_API_RETRY_MS=0 in the environment makes a default client fail at once", async () => {
		const prev = process.env.OB_API_RETRY_MS;
		process.env.OB_API_RETRY_MS = "0";
		try {
			const t = flaky([refused], { leases: [] });
			const client = new ApiClient({ base: BASE, token: TOKEN, transport: t.transport });
			const err = await client.leases().catch((e: unknown) => e);
			expect((err as ApiError).unreachable).toBe(true);
			expect(t.calls).toEqual(["GET"]);
		} finally {
			if (prev === undefined) delete process.env.OB_API_RETRY_MS;
			else process.env.OB_API_RETRY_MS = prev;
		}
	});
});

describe("a file download retries a refused connection only (OB-2160)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	test("refused, then the file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ob-retry-2160-"));
		dirs.push(dir);
		const c = clock();
		let calls = 0;
		const client = new ApiClient({
			base: BASE,
			token: TOKEN,
			retry: c.retry,
			download: async () => {
				calls += 1;
				if (calls === 1) throw refused();
				return new Response("bytes", { status: 200, headers: { "content-type": "application/octet-stream" } });
			},
		});
		const n = await client.dbSnapshotFetch("snap", join(dir, "out"));
		expect(n).toBe(5);
		expect(readFileSync(join(dir, "out"), "utf8")).toBe("bytes");
		expect(calls).toBe(2);
	});

	test("a reset is not retried", async () => {
		const c = clock();
		let calls = 0;
		const client = new ApiClient({
			base: BASE,
			token: TOKEN,
			retry: c.retry,
			download: async () => {
				calls += 1;
				throw reset();
			},
		});
		const err = await client.dbSnapshotFetch("snap", join(tmpdir(), "never-written-2160")).catch((e: unknown) => e);
		expect((err as ApiError).message).toContain("could not fetch from the ob API");
		expect(calls).toBe(1);
	});
});

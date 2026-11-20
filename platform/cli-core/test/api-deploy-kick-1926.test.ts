// OB-1926: the API kick and the deploy record must not claim an outcome that is not true.
//
// - Two concurrent kicks used to both read `inactive` and both answer `kicked`; the kick is now serialised in-process.
// - An is-active that timed out (or printed nothing a unit state could be) used to be read as "not running" and
//   proceed; it is now a refusal that records `refused` and starts nothing.
// - recordDeploy never lets an older `at` overwrite a newer row, so a script `ok` decided before a kick's `refused`
//   cannot land on top of it.
//
// Hermetic: systemctl is a fake, the store is a temp sqlite file or the local pg test harness. No systemd, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { DEPLOY_START_ARGV, type DeployCommandResult } from "../../../apps/cli/src/api/deploy-kick.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { listDeploys, recordDeploy } from "../../../apps/cli/src/commands/deploy.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore, openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";

const TOKEN = "a-test-bearer-token-that-is-long-enough";
const SHA = "abc1234def5678";

let dir: string;
let requestFile: string;
let ran: string[][];
beforeEach(() => {
	dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-1926-"));
	requestFile = join(dir, "deploy-request");
	ran = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sqliteStore(): Store {
	return asStore(openDb(freshDbPath()));
}

function api(store: Store, run: (argv: readonly string[]) => Promise<DeployCommandResult>) {
	return createObApi({
		store: async () => store,
		token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
		deployKick: {
			env: { OMNISLASH_API_DEPLOY_ENABLED: "1", OMNISLASH_DEPLOY_REQUEST_FILE: requestFile },
			run: async (argv) => {
				ran.push([...argv]);
				return run(argv);
			},
		},
	});
}

const post = (body: unknown) =>
	new Request(`http://api-host.local${OB_API_PREFIX}/deploys/run`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify(body),
	});

describe("POST /deploys/run (OB-1926)", () => {
	test("two concurrent kicks produce one start; the second sees the first as running", async () => {
		// systemd's view: inactive until a start lands, activating after. The is-active answer takes a tick, so
		// without serialisation both checks would read `inactive` before either start.
		let state = "inactive";
		const fake = async (argv: readonly string[]): Promise<DeployCommandResult> => {
			await Bun.sleep(10);
			if (argv[1] === "is-active") return { code: state === "active" ? 0 : 3, stdout: `${state}\n`, stderr: "" };
			state = "activating";
			return { code: 0, stdout: "", stderr: "" };
		};
		const handler = api({} as Store, fake);
		const [a, b] = await Promise.all([handler(post({ sha: SHA })), handler(post({}))]);
		expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
		const loser = a.status === 409 ? a : b;
		expect(((await loser.json()) as { error: { message: string } }).error.message).toContain("already running");
		expect(ran.filter((r) => r.includes("start"))).toEqual([[...DEPLOY_START_ARGV]]);
	});

	test("an is-active that timed out refuses, records refused and starts nothing, even with a partial state on stdout", async () => {
		const store = sqliteStore();
		await recordDeploy(store, { target: "live", host: "api-host", unit: "omnislash-web.service", sha: "serving", at: "2026-01-01T00:00:00.000Z", result: "ok" });
		const res = await api(store, async () => ({ code: 143, stdout: "inactive\n", stderr: "", timedOut: true }))(post({ sha: SHA }));
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { message: string } }).error.message).toContain("timed out");
		expect(ran).toEqual([["systemctl", "is-active", "omnislash-deploy.service"]]);
		expect(existsSync(requestFile)).toBe(false);
		expect((await listDeploys(store)).find((d) => d.target === "live")).toMatchObject({ sha: "serving", result: "refused" });
	});

	test("an is-active that printed no known state, or could not spawn, refuses and starts nothing", async () => {
		for (const answer of [
			async () => ({ code: 0, stdout: "weird\n", stderr: "" }),
			async (): Promise<DeployCommandResult> => {
				throw new Error("spawn systemctl ENOENT");
			},
		]) {
			ran = [];
			const store = sqliteStore();
			const res = await api(store, answer)(post({}));
			expect(res.status).toBe(409);
			expect(ran).toHaveLength(1);
			expect(existsSync(requestFile)).toBe(false);
			expect((await listDeploys(store)).find((d) => d.target === "live")?.result).toBe("refused");
		}
	});
});

describe("recordDeploy: an older write never overwrites a newer row (OB-1926)", () => {
	const row = (at: string, result: "ok" | "refused", sha = "s") => ({ target: "live", host: "api-host", unit: "omnislash-web.service", sha, at, result });

	async function exercise(store: Store) {
		await recordDeploy(store, row("2026-01-02T10:00:05.000Z", "refused", "old"));
		// The script's ok, decided at :00 (before the restart), lands after the kick's refused at :05: ignored.
		await recordDeploy(store, row("2026-01-02T10:00:00.000Z", "ok", "new"));
		expect((await listDeploys(store))[0]).toMatchObject({ result: "refused", sha: "old", at: "2026-01-02T10:00:05.000Z" });
		// Equal applies.
		await recordDeploy(store, row("2026-01-02T10:00:05.000Z", "ok", "new"));
		expect((await listDeploys(store))[0]).toMatchObject({ result: "ok", sha: "new" });
		// Newer applies.
		await recordDeploy(store, row("2026-01-02T10:00:09.000Z", "refused", "newer"));
		expect((await listDeploys(store))[0]).toMatchObject({ result: "refused", sha: "newer", at: "2026-01-02T10:00:09.000Z" });
		// No `at` means now, which is newer than anything above.
		await recordDeploy(store, { target: "live", host: "api-host", unit: "omnislash-web.service", sha: "now", result: "ok" });
		expect((await listDeploys(store))[0]).toMatchObject({ result: "ok", sha: "now" });
		expect(await listDeploys(store)).toHaveLength(1);
	}

	test("an offset or odd-shaped at is stored as one canonical instant, and a non-date is refused", async () => {
		const store = sqliteStore();
		await recordDeploy(store, row("2026-01-02T12:00:00+02:00", "ok"));
		expect((await listDeploys(store))[0]?.at).toBe("2026-01-02T10:00:00.000Z");
		await expect(recordDeploy(store, row("now", "refused"))).rejects.toThrow("not a date");
		expect((await listDeploys(store))[0]?.result).toBe("ok");
	});

	test("sqlite", async () => {
		await exercise(sqliteStore());
	});

	test("postgres", async () => {
		const lease = await leaseRealPgDb();
		const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
		try {
			await exercise(store);
		} finally {
			await store.close();
			await lease.release();
		}
	});
});

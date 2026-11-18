// OB-1809 -- `ob deploy run` from an API client: POST /deploys/run, with ssh only as a named last resort.
//
// Hermetic: the client goes through a stub transport, the server's systemctl is a fake, and ssh is a fake. Nothing
// reaches systemd or the network. The script's half of the pin is driven for real in ob-deploy-pin-1534.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { DEPLOY_START_ARGV, type DeployCommandResult } from "../../../apps/cli/src/api/deploy-kick.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { listDeploys, recordDeploy } from "../../../apps/cli/src/commands/deploy.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";

const BASE = "https://ob.example.test";
const TOKEN = "a-test-bearer-token-that-is-long-enough";
const SHA = "abc1234def5678";

function stub(answer: (req: ApiRequest) => { status: number; body: unknown } | Error) {
	const calls: ApiRequest[] = [];
	const transport: ApiTransport = async (req) => {
		calls.push(req);
		const out = answer(req);
		if (out instanceof Error) throw out;
		return { status: out.status, body: JSON.stringify(out.body) };
	};
	return { calls, api: { base: BASE, token: TOKEN, transport } };
}

const fault = (status: number, message: string) => ({ status, body: { error: { code: "x", message } } });
const neverSsh = () => {
	throw new Error("ssh must not run");
};

describe("the client: ob deploy run", () => {
	test("is one API call and no ssh; the bare form sends no pin", async () => {
		const s = stub(() => ({ status: 200, body: { kicked: true, target: "live" } }));
		const r = await runCli(freshDbPath(), ["deploy", "run"], { api: s.api, deploySsh: neverSsh });
		expect(r.code).toBe(0);
		expect(r.out).toContain("live deploy kicked");
		expect(s.calls.map((c) => [c.method, c.url])).toEqual([["POST", `${BASE}${OB_API_PREFIX}/deploys/run`]]);
		expect(JSON.parse(s.calls[0]!.body!)).toEqual({});
	});

	test("--sha travels as the pin and --json says so", async () => {
		const s = stub(() => ({ status: 200, body: { kicked: true, target: "live", sha: SHA } }));
		const r = await runCli(freshDbPath(), ["deploy", "run", "--sha", SHA, "--json"], { api: s.api, deploySsh: neverSsh });
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out)).toEqual({ kicked: true, target: "live", sha: SHA });
		expect(JSON.parse(s.calls[0]!.body!)).toEqual({ sha: SHA });
	});

	test("a pin that is not a commit id is a usage error before any request or ssh", async () => {
		for (const bad of ["main", "ABC1234", "abc12", "abc1234; reboot"]) {
			for (const extra of [[], ["--ssh"]]) {
				const s = stub(() => new Error("no request"));
				const r = await runCli(freshDbPath(), ["deploy", "run", "--sha", bad, ...extra], { api: s.api, deploySsh: neverSsh });
				expect(r.code).toBe(2);
				expect(s.calls).toEqual([]);
			}
		}
	});

	test("a lost answer says the deploy may have started, and neither retries nor falls back", async () => {
		for (const answer of [() => new Error("connection reset"), () => fault(502, "bad gateway")]) {
			const s = stub(answer);
			const r = await runCli(freshDbPath(), ["deploy", "run"], { api: s.api, deploySsh: neverSsh });
			expect(r.code).toBe(1);
			expect(r.err).toContain("may have started");
			expect(r.err).toContain("ob deploy status");
			expect(r.err).toContain("ob deploy run --ssh");
			expect(s.calls).toHaveLength(1);
		}
	});

	test("--ssh is the last resort: it carries the pin and works with the API down", async () => {
		const s = stub(() => new Error("API down"));
		const argv: string[][] = [];
		const r = await runCli(freshDbPath(), ["deploy", "run", "--ssh", "--sha", SHA], {
			api: s.api,
			deploySsh: (a) => {
				argv.push([...a]);
				return { code: 0 };
			},
		});
		expect(r.code).toBe(0);
		expect(argv[0]!.at(-1)).toContain(`OMNISLASH_DEPLOY_SHA=${SHA}`);
		expect(s.calls.some((c) => c.url.endsWith("/deploys/run"))).toBe(false);
	});

	test("--ssh failing with the API down says the refusal could not be recorded", async () => {
		const s = stub(() => new Error("API down"));
		const r = await runCli(freshDbPath(), ["deploy", "run", "--ssh"], { api: s.api, deploySsh: () => ({ code: 255 }) });
		expect(r.code).toBe(1);
		expect(r.err).toContain("ssh to ob-host failed");
		expect(r.err).toContain("could not record it");
		// Not knowing what serves, it must not overwrite the live row with sha "unknown".
		expect(s.calls.some((c) => c.method === "POST")).toBe(false);
	});
});

describe("the server: POST /deploys/run", () => {
	let dir: string;
	let requestFile: string;
	let ran: string[][];
	beforeEach(() => {
		dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-1809-"));
		requestFile = join(dir, "deploy-request");
		ran = [];
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function api(opts: { state?: string; start?: DeployCommandResult; enabled?: boolean; store?: Store } = {}) {
		return createObApi({
			store: async () => opts.store ?? ({} as Store),
			token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
			deployKick: {
				env: { OMNISLASH_API_DEPLOY_ENABLED: opts.enabled === false ? undefined : "1", OMNISLASH_DEPLOY_REQUEST_FILE: requestFile },
				run: async (argv) => {
					ran.push([...argv]);
					if (argv[1] === "is-active") return { code: 3, stdout: `${opts.state ?? "inactive"}\n`, stderr: "" };
					return opts.start ?? { code: 0, stdout: "", stderr: "" };
				},
			},
		});
	}
	const post = (body: unknown, token: string | null = TOKEN) =>
		new Request(`http://api-host.local${OB_API_PREFIX}/deploys/run`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify(body),
		});

	test("no bearer token, or the wrong one, starts nothing", async () => {
		for (const token of [null, "wrong-token"]) {
			const res = await api()(post({}, token));
			expect(res.status).toBe(401);
		}
		expect(ran).toEqual([]);
		expect(existsSync(requestFile)).toBe(false);
	});

	test("a kick starts the unit through systemd and never runs the script itself", async () => {
		const res = await api()(post({ sha: SHA }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ kicked: true, target: "live", sha: SHA });
		expect(ran).toEqual([["systemctl", "is-active", "omnislash-deploy.service"], [...DEPLOY_START_ARGV]]);
		expect(readFileSync(requestFile, "utf8")).toBe(`${SHA}\n`);
	});

	test("an unpinned kick replaces a pin an older kick left behind", async () => {
		writeFileSync(requestFile, `${SHA}\n`);
		expect((await api()(post({}))).status).toBe(200);
		expect(readFileSync(requestFile, "utf8")).toBe("");
	});

	test("a pin is validated as DEPLOY_SHA_RE does, before anything runs or is written", async () => {
		for (const sha of [null, "main", "ABC1234", "abc12", "abc1234\nreboot", "../../etc/passwd", `${"a".repeat(41)}`]) {
			expect((await api()(post({ sha }))).status).toBe(400);
		}
		expect(ran).toEqual([]);
		expect(existsSync(requestFile)).toBe(false);
	});

	test("an instance that is not the live unit refuses: a dev server cannot restart production", async () => {
		const res = await api({ enabled: false })(post({}));
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { message: string } }).error.message).toContain("run the install script");
		expect(ran).toEqual([]);
	});

	test("a deploy already running refuses, and leaves its request alone", async () => {
		for (const state of ["activating", "deactivating"]) {
			const res = await api({ state })(post({ sha: SHA }));
			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: { message: string } }).error.message).toContain("already running");
		}
		expect(ran.every((a) => a[1] === "is-active")).toBe(true);
		expect(existsSync(requestFile)).toBe(false);
		// A failed last run is not a running one.
		expect((await api({ state: "failed" })(post({}))).status).toBe(200);
	});

	test("a start that fails records refused at the SHA still serving, keeps the pin and names the fix", async () => {
		const lease = await leaseRealPgDb();
		const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
		try {
			await recordDeploy(store, { target: "live", host: "api-host", unit: "omnislash-web.service", sha: "serving", result: "ok" });
			const res = await api({ store, start: { code: 1, stdout: "", stderr: "sudo: a password is required" } })(post({ sha: SHA }));
			expect(res.status).toBe(409);
			const { message } = ((await res.json()) as { error: { message: string } }).error;
			expect(message).toContain("sudo: a password is required");
			expect(message).toContain("run the install script");
			expect(readFileSync(requestFile, "utf8")).toBe(`${SHA}\n`); // a timed-out start may still be queued: it must not lose its pin
			expect((await listDeploys(store)).find((d) => d.target === "live")).toMatchObject({ sha: "serving", result: "refused" });
		} finally {
			await store.close();
			await lease.release();
		}
	});
});

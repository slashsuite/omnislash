import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INFER_PROJECT_ERROR } from "../../../apps/cli/src/commands/capture.ts";
import { freshDbPath, psSh, runCli } from "../../../apps/cli/test/helpers.ts";
import { __setSh } from "../../cli-coord/src/commands/spinoff.ts";
import {
	API_BASE_ENV,
	API_TOKEN_ENV,
	missingApiTokenMessage,
	resolveApiBase,
	resolveApiToken,
} from "../../../apps/cli/src/api/config.ts";
import { OB_API_TOKEN_FILE_ENV, tokenPath } from "../../../apps/cli/src/api/token.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { __setT3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { API_ROUTED_COMMANDS, LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { redactToken } from "../../../apps/cli/src/api/client.ts";

// ob 353 — `ob` routes through ob 352's API, and it does so on the LAN as well as off it.
//
// Everything here runs against a STUBBED transport: the suite reaches no network, needs no token file and
// touches no database. The facts worth pinning are the ones that cost real time when they go wrong: a
// command that should never reach HTTP does not, a flag with no endpoint behind it REFUSES instead of
// being dropped, and the token never leaves the Authorization header.

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

interface Stub {
	transport: ApiTransport;
	calls: ApiRequest[];
}

function stub(answers: Record<string, unknown>): Stub {
	const calls: ApiRequest[] = [];
	const transport: ApiTransport = async (req) => {
		calls.push(req);
		const suffix = req.url.slice((BASE + OB_API_PREFIX).length);
		// An answer keyed on the query wins over the path's (1226): a test can pin what a queried read is
		// told while every other read of the same path keeps answering as it always did.
		const key = `${req.method} ${suffix}`;
		const fallback = `${req.method} ${suffix.split("?")[0]!}`;
		const chosen = key in answers ? key : fallback;
		if (!(chosen in answers)) {
			return {
				status: 404,
				body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }),
			};
		}
		return { status: 200, body: JSON.stringify(answers[chosen]) };
	};
	return { transport, calls };
}

function view(id: string, title: string) {
	return {
		id,
		type: "task",
		title,
		status: "open",
		priority: null,
		effective_priority: "none",
		today_rank: null,
		project: null,
		kind: null,
		block_reason: null,
		block_owner: null,
		created_at: "2026-08-18T00:00:00.000Z",
		updated_at: "2026-08-18T00:00:00.000Z",
		closed_at: null,
	};
}

function api(s: Stub) {
	return { api: { base: BASE, token: TOKEN, transport: s.transport } };
}

describe("the API client's configuration (353)", () => {
	test("a base url comes from the environment, and an unset one means this machine is not a client", () => {
		expect(resolveApiBase("https://ob.example.test/")).toBe("https://ob.example.test");
		expect(resolveApiBase("")).toBe(null);
	});

	test("a trailing path is kept and a trailing slash is not", () => {
		expect(resolveApiBase("https://host.test/ob/")).toBe("https://host.test/ob");
	});

	test("a credential in the url is REFUSED: the token belongs in a header, never in the address", () => {
		expect(() => resolveApiBase("https://user:secret@host.test")).toThrow(/username or password/);
	});

	test("a url that is not http(s) is refused by name", () => {
		expect(() => resolveApiBase("postgres://host/db")).toThrow(/must be http or https/);
	});

	test("the client reads the SAME token file the server authenticates against (352's token.ts)", () => {
		// One definition of where the credential lives, shared by both ends.
		expect(missingApiTokenMessage(tokenPath(), null)).toContain(tokenPath());
	});

	test("the missing-token message is a setup guide: the path, the mode, and the two commands", () => {
		const msg = missingApiTokenMessage(tokenPath(), null);
		expect(msg).toContain("Mode 0600");
		expect(msg).toContain("chmod 0600");
		expect(msg).toContain("printf");
		expect(msg).toContain(API_TOKEN_ENV);
		expect(msg).toContain(OB_API_TOKEN_FILE_ENV);
		// It must NOT send a reader to the secret store: that lives inside the database the API fronts.
		expect(msg).toContain("NOT an 'ob secret'");
	});

	test("the token is read from a file, and a loose mode warns without refusing", () => {
		const dir = mkdtempSync(join(tmpdir(), "ob-api-token-"));
		const path = join(dir, "token");
		writeFileSync(path, `${TOKEN}\n`);
		chmodSync(path, 0o644);
		const prev = process.env[OB_API_TOKEN_FILE_ENV];
		const prevEnvToken = process.env[API_TOKEN_ENV];
		delete process.env[API_TOKEN_ENV];
		process.env[OB_API_TOKEN_FILE_ENV] = path;
		try {
			expect(resolveApiToken()).toBe(TOKEN);
		} finally {
			if (prev === undefined) delete process.env[OB_API_TOKEN_FILE_ENV];
			else process.env[OB_API_TOKEN_FILE_ENV] = prev;
			if (prevEnvToken !== undefined) process.env[API_TOKEN_ENV] = prevEnvToken;
		}
	});

	test("a missing token file is the setup guide, not a stack trace", () => {
		const prevFile = process.env[OB_API_TOKEN_FILE_ENV];
		const prevToken = process.env[API_TOKEN_ENV];
		delete process.env[API_TOKEN_ENV];
		process.env[OB_API_TOKEN_FILE_ENV] = join(tmpdir(), "ob-api-token-that-does-not-exist");
		try {
			expect(() => resolveApiToken()).toThrow(/no usable ob API token/);
		} finally {
			if (prevFile === undefined) delete process.env[OB_API_TOKEN_FILE_ENV];
			else process.env[OB_API_TOKEN_FILE_ENV] = prevFile;
			if (prevToken !== undefined) process.env[API_TOKEN_ENV] = prevToken;
		}
	});
});

describe("routing: one data path, or a loud refusal (353, map decision D2/D3)", () => {
	test("every routed command has a handler, and every handler is a routed command", () => {
		expect(Object.keys(API_HANDLERS).sort()).toEqual([...API_ROUTED_COMMANDS].sort());
	});

	test("a LOCAL-ONLY command refuses BY NAME and never reaches HTTP", async () => {
		for (const [command, spec] of LOCAL_ONLY_COMMANDS) {
			if (spec.disposition !== "refuse") continue;
			const s = stub({});
			const r = await runCli(freshDbPath(), [command], api(s));
			expect(r.code).toBe(1);
			expect(r.err).toContain(`'ob ${command}' is a LOCAL command`);
			expect(r.err).toContain(spec.reason);
			// The point of the class: it does not half-run, and it does not ask the API to do it either.
			expect(s.calls).toEqual([]);
		}
	});

	test("`ob daemon` is LOCAL and still runs here: it writes launchd plists and reads no tracker data", async () => {
		const s = stub({});
		const r = await runCli(freshDbPath(), ["daemon", "status"], api(s));
		expect(r.code).toBe(0);
		// The one client job is role-tick (OS-67), so the answer is its local unit, never a server unit.
		expect(r.out).toContain("role-tick");
		expect(r.out).toContain("role tick");
		expect(r.out).not.toContain("omnislash-sync");
		expect(r.out).not.toContain("com.omnislash.sync");
		expect(s.calls).toEqual([]);
	});

	test("an unknown command is still a usage error, not an unrouted refusal (416 killed the third class)", async () => {
		const s = stub({});
		const r = await runCli(freshDbPath(), ["definitely-not-a-command"], api(s));
		expect(r.code).toBe(2);
		expect(r.err).toContain("unknown command");
		expect(r.err).not.toContain("not routed through the ob API yet");
		expect(s.calls).toEqual([]);
	});

});

describe("the working loop over HTTP (353)", () => {
	test("`ob next` renders the API's items, under the prefix, with the token in the header alone", async () => {
		const s = stub({ "GET /next": { items: [view("42", "ship the api client")], triage_count: 0, focus_project: null } });
		const r = await runCli(freshDbPath(), ["next"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("42");
		expect(r.out).toContain("ship the api client");
		expect(s.calls).toHaveLength(1);
		const call = s.calls[0]!;
		expect(call.url).toBe(`${BASE}${OB_API_PREFIX}/next`);
		expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
		// The token is in exactly one place, and the url is not it.
		expect(call.url).not.toContain(TOKEN);
	});

	test("`ob next` shows the triage banner the endpoint counted", async () => {
		const s = stub({ "GET /next": { items: [], triage_count: 3, focus_project: null } });
		const r = await runCli(freshDbPath(), ["next"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("3");
	});

	test("`ob list --json` sends the filters as query parameters and prints parseable JSON", async () => {
		const s = stub({ "GET /items": { items: [view("7", "a thing")], focus_project: null } });
		const r = await runCli(freshDbPath(), ["list", "--open", "--json", "--limit", "5"], api(s));
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out)[0].id).toBe("7");
		expect(s.calls[0]!.url).toContain("open=true");
		expect(s.calls[0]!.url).toContain("limit=5");
	});

	test("a usage error is caught before any request is made", async () => {
		const s = stub({});
		const r = await runCli(freshDbPath(), ["list", "--limit", "not-a-number"], api(s));
		expect(r.code).toBe(2);
		expect(s.calls).toEqual([]);
	});

	test("`ob show` renders the composed detail the endpoint returned", async () => {
		const s = stub({
			"GET /items/42": {
				item: {
					...view("42", "ship the api client"),
					body: "the body",
					tags: ["backend"],
					links: [],
					linear: null,
					detail: null,
					events: [],
					prs: [],
					valid_next: ["doing"],
				},
			},
		});
		const r = await runCli(freshDbPath(), ["show", "42"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("42  ship the api client");
		expect(r.out).toContain("tags:      backend");
		expect(r.out).toContain("the body");
	});

	test("`ob add` posts the item and prints its id", async () => {
		const s = stub({ "POST /items": { id: "99", item: view("99", "a new task") } });
		const r = await runCli(freshDbPath(), ["add", "a new task", "--project", "acme"], api(s));
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("99");
		expect(JSON.parse(s.calls[0]!.body!).title).toBe("a new task");
	});

	test("`ob add` does not warn about Cue work", async () => {
		const s = stub({ "POST /items": { id: "99", item: view("99", "CUE-1234 fix it") } });
		const r = await runCli(freshDbPath(), ["add", "CUE-1234 fix it", "--project", "acme", "--json"], api(s));
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out).id).toBe("99");
		expect(r.err).not.toContain("looks like Cue work");
	});

	describe("ob add over the API (243): project is inferred on THIS machine before the wire", () => {
		function gitCheckout(remote: string): string {
			const dir = mkdtempSync(join(tmpdir(), "ob-243-api-"));
			execSync("git init -q", { cwd: dir });
			execSync(`git remote add origin ${remote}`, { cwd: dir });
			return dir;
		}

		test("a cwd inside a checkout puts the right project on the request body", async () => {
			const side = gitCheckout("https://github.com/owner/acme.git");
			const other = gitCheckout("git@github.com:acmecorp/cue-app.git");
			try {
				const fromSide = stub({ "POST /items": { id: "1", item: view("1", "x") } });
				const sideRun = await runCli(freshDbPath(), ["add", "x"], { ...api(fromSide), cwd: side });
				expect(sideRun.code).toBe(0);
				expect(JSON.parse(fromSide.calls[0]!.body!).project).toBe("acme");

				const fromOther = stub({ "POST /items": { id: "2", item: view("2", "x") } });
				const otherRun = await runCli(freshDbPath(), ["add", "x"], { ...api(fromOther), cwd: other });
				expect(otherRun.code).toBe(2);
				expect(otherRun.err).toContain(INFER_PROJECT_ERROR);
				expect(fromOther.calls).toEqual([]);
			} finally {
				rmSync(side, { recursive: true, force: true });
				rmSync(other, { recursive: true, force: true });
			}
		});

		test("an explicit --project (or --repo) passes through untouched", async () => {
			const dir = gitCheckout("https://github.com/owner/acme.git");
			try {
				const project = stub({ "POST /items": { id: "1", item: view("1", "x") } });
				const projectRun = await runCli(freshDbPath(), ["add", "x", "--project", "already"], {
					...api(project),
					cwd: dir,
				});
				expect(projectRun.code).toBe(0);
				expect(JSON.parse(project.calls[0]!.body!).project).toBe("already");

				const repo = stub({ "POST /items": { id: "2", item: view("2", "x") } });
				const repoRun = await runCli(freshDbPath(), ["add", "x", "--repo", "already"], {
					...api(repo),
					cwd: dir,
				});
				expect(repoRun.code).toBe(0);
				expect(JSON.parse(repo.calls[0]!.body!).project).toBe("already");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("a cwd outside any checkout still gives the existing clear error, and nothing is posted", async () => {
			const bare = mkdtempSync(join(tmpdir(), "ob-243-api-bare-"));
			try {
				const s = stub({ "POST /items": { id: "1", item: view("1", "x") } });
				const r = await runCli(freshDbPath(), ["add", "x"], { ...api(s), cwd: bare });
				expect(r.code).toBe(2);
				expect(r.err).toContain(INFER_PROJECT_ERROR);
				expect(s.calls).toEqual([]);
			} finally {
				rmSync(bare, { recursive: true, force: true });
			}
		});
	});

	test("a flag with no endpoint behind it REFUSES rather than being dropped", async () => {
		for (const argv of [
			["add", "x", "--type", "decision", "--choice", "c"],
			["tag", "42", "backend", "--repo", "acme"],
			["close", "42", "--dry-run"],
		]) {
			const s = stub({});
			const r = await runCli(freshDbPath(), argv, api(s));
			expect(r.code).toBe(2);
			expect(r.err).toContain("is not available through the ob API");
			// Nothing was written, on either side.
			expect(s.calls).toEqual([]);
		}
	});

	// 352b: `ob agent active` USED to be on the refusal list above, because the liveness count had no
	// endpoint. StayAwake polls it on a timer, so a refusal there does not annoy a person, it lets the
	// machine sleep in the middle of a build. It now goes over the wire like everything else.
	test("`ob agent active` asks the endpoint and renders the server's verdict", async () => {
		const s = stub({ "GET /agents/active": { active: true, count: 2, within_min: 20 } });
		const r = await runCli(freshDbPath(), ["agent", "active"], api(s));
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("active (2 within 20m)");
		expect(s.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${BASE}${OB_API_PREFIX}/agents/active`]);

		// `--within` is carried, not dropped, and the server's echoed window is what gets printed.
		const s2 = stub({ "GET /agents/active": { active: false, count: 0, within_min: 5 } });
		const r2 = await runCli(freshDbPath(), ["agent", "active", "--within", "5"], api(s2));
		expect(r2.code).toBe(0);
		expect(r2.out.trim()).toBe("dormant (none within 5m)");
		expect(s2.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/agents/active?within_min=5`);

		// A window that cannot mean anything is refused HERE, before a request is made.
		const s3 = stub({});
		const r3 = await runCli(freshDbPath(), ["agent", "active", "--within", "0"], api(s3));
		expect(r3.code).toBe(2);
		expect(s3.calls).toEqual([]);
	});

	test("`ob close` prints the GitHub mirror the server managed", async () => {
		const s = stub({
			"POST /items/42/close": {
				id: "42",
				status: "done",
				issue: 7,
				issue_url: "https://github.com/x/y/issues/7",
				issue_state: "closed",
				already: false,
				skipped: null,
				issue_error: null,
			},
		});
		const r = await runCli(freshDbPath(), ["close", "42"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("closed issue #7");
	});

	test("a mirror the server could NOT move is a loud non-zero exit, and the local close still stands", async () => {
		const s = stub({
			"POST /items/42/close": {
				id: "42",
				status: "done",
				issue: 7,
				issue_url: "https://github.com/x/y/issues/7",
				issue_state: null,
				already: null,
				skipped: null,
				issue_error: "gh: rate limited",
			},
		});
		const r = await runCli(freshDbPath(), ["close", "42"], api(s));
		expect(r.code).toBe(1);
		expect(r.err).toContain("out of sync");
		expect(r.err).toContain("gh: rate limited");
	});

	test("`ob state <id> done` goes to /close, not /state: landing closes the linked issue too (77)", async () => {
		const s = stub({
			"POST /items/42/close": {
				id: "42",
				status: "done",
				issue: null,
				issue_url: null,
				issue_state: null,
				already: null,
				skipped: "no-link",
				issue_error: null,
			},
		});
		const r = await runCli(freshDbPath(), ["state", "42", "done"], api(s));
		expect(r.code).toBe(0);
		expect(s.calls.some((c) => c.url.includes("/items/42/close"))).toBe(true);
	});

	// ---------------------------------------------------------------------------------------------------
	// 1163 / 1226 — settle-on-close joins the ROW to the ITEM, and the join is decided where the STORE is.
	// Row 591 was dispatched as "1124" while its ob mirror is item 1134; and ref "1133" is both an item's
	// id (the strip's mirror) and the wayfinder number of another ticket (mirror item 1135). A client holds
	// T3 and no database, so it asks one read — `POST /spinoffs/serving` — rather than matching two
	// namespaces itself, which is what bound the wrong row and told the wrong thread it had landed.
	// ---------------------------------------------------------------------------------------------------

	/** The seam a settle needs: only `settle` is ever reached for a close. */
	function settleSeam(
		settled: string[],
		queue: { held?: Array<{ queuedRunId: string; text: string; truncated: boolean }>; cancelled?: Array<{ threadId: string; queuedRunId: string }> } = {},
	) {
		return __setT3Seam({
			projects: async () => [],
			capabilities: async () => ({ runtimeMode: "full-access", providers: [] }),
			list: async () => ({ projectId: "p", threads: [], nextCursor: null }),
			read: async (threadId: string) => {
				throw new Error(`nothing to read (${threadId})`);
			},
			launch: async () => {
				throw new Error("settle-on-close never launches");
			},
			rename: async () => {},
			settle: async (threadId: string) => {
				settled.push(threadId);
			},
			// 1133 added send/wait to the seam (the readying note and the land reply). A close now sends the
			// land reply before it settles, so this fake answers both: the send records nothing and the wait
			// returns at once, which is what an idle thread does — leaving the settle below the thing under test.
			send: async () => {},
			wait: async () => ({ runId: null, status: "completed", timedOut: false }),
			// 1205: a close also withdraws a readying note still HELD by the architect thread. Empty by default
			// (nothing held), with the held set and the withdrawals injectable for the test that needs them.
			queue: async () => ({ items: queue.held ?? [], complete: true }),
			interrupt: async () => {},
			pin: async () => {},
			unpin: async () => {},
			disableAutoSettle: async () => {},
			queueCancel: async (threadId, queuedRunId) => {
				queue.cancelled?.push({ threadId, queuedRunId });
			},
		});
	}

	/** The closed item's own record, naming the wayfinder ticket it mirrors — row 591's real item. */
	const mirror1134 = {
		...view("1134", "T3 integration P1"),
		body: "wayfinder/tickets/1124-t3-read-surface.md — the read half",
	};

	const closed1134 = { id: "1134", status: "done", issue: null, issue_url: null, issue_state: null, already: null, skipped: "no-link", issue_error: null };

	test("`ob close` settles the threads of the rows the serving read names (1163)", async () => {
		const settled: string[] = [];
		const restore = settleSeam(settled);
		try {
			const s = stub({
				"POST /items/1134/close": closed1134,
				// the SERVER's answer for item 1134: row 591, dispatched under the WAYFINDER number, item_id
				// NULL (queued before 0032). The item's record names that ref; this machine cannot read it.
				"POST /spinoffs/serving": { spinoffs: [{ id: 591, ticket_ref: "1124", branch: "1124", worktree: "/home/owner/dev/acme.1124", status: "merged", t3_thread_id: "mcp:row591", item_id: null }] },
			});
			const r = await runCli(freshDbPath(), ["close", "1134"], api(s));
			expect(r.code).toBe(0);
			expect(settled).toEqual(["mcp:row591"]);
			expect(r.out).toContain("t3 thread mcp:row591 settled");
			// The ONE read asks the question; nothing reads the item's record any more, because resolving the
			// row's ref against its ticket path is the store's job.
			expect(s.calls.map((c) => `${c.method} ${c.url.replace(BASE + OB_API_PREFIX, "")}`)).toEqual([
				// an id in the BODY, never in the url: a url is logged by every proxy in front (357). OB-1993 reads it
				// once BEFORE the close too, so the client can send the token counts it read for the rows.
				"POST /spinoffs/serving",
				"POST /items/1134/close",
				"POST /spinoffs/serving",
			]);
			expect(JSON.parse(s.calls[0]!.body!)).toEqual({ item_id: "1134" });
		} finally {
			restore();
		}
	});

	test("`ob close 1133` settles only the rows the server says serve it — the colliding ref belongs to 1135 (1226)", async () => {
		const settled: string[] = [];
		const restore = settleSeam(settled);
		try {
			const s = stub({
				"POST /items/1133/close": { ...closed1134, id: "1133" },
				// Item 1133 is the STRIP's mirror, and its own row was dispatched under its wayfinder number
				// 1121. The readying-note row (ref "1133") is absent on purpose: that ref names item 1135's
				// ticket path, so it serves 1135 — and `ob close 1133` must not tell its builder it landed.
				"POST /spinoffs/serving": {
					spinoffs: [{ id: 600, ticket_ref: "1121", branch: "1121", worktree: "/w", status: "merged", t3_thread_id: "mcp:strip", item_id: "1133" }],
					// A candidate the SERVER could not settle travels with the answer by name, and the close
					// says so rather than letting an absent row read as "nothing to settle".
					unresolved: [{ id: 596, ticket_ref: "1133" }],
				},
			});
			const r = await runCli(freshDbPath(), ["close", "1133"], api(s));
			expect(r.code).toBe(0);
			expect(settled).toEqual(["mcp:strip"]);
			expect(r.out).toContain("t3 thread mcp:strip settled");
			expect(r.err).toContain("spinoff #596 (ref '1133')");
			expect(r.err).toContain("left unresolved");
			expect(s.calls.some((c) => c.url.endsWith("/spinoffs/serving") && JSON.parse(c.body ?? "{}").item_id === "1133")).toBe(true);
		} finally {
			restore();
		}
	});

	test("a close settles from the serving answer alone, and stops there when it has threads to settle (1163)", async () => {
		const settled: string[] = [];
		const restore = settleSeam(settled);
		try {
			const s = stub({
				"POST /items/1134/close": closed1134,
				"POST /spinoffs/serving": { spinoffs: [{ id: 591, ticket_ref: "1124", branch: "1124", worktree: "/w", status: "launched", t3_thread_id: "mcp:row591", item_id: "1134" }] },
			});
			const r = await runCli(freshDbPath(), ["close", "1134"], api(s));
			expect(r.code).toBe(0);
			expect(settled).toEqual(["mcp:row591"]);
			// Only serving reads (OB-1993 adds one before the close, for the tokens), and no item read: the unfiltered
			// LIST is only asked for when there is nothing to settle and the close owes the human a sentence about why.
			expect(s.calls.filter((c) => c.url.includes("/spinoffs")).map((c) => c.url.endsWith("/spinoffs/serving"))).toEqual([true, true]);
			expect(s.calls.some((c) => c.method === "GET" && c.url.includes("/items/1134"))).toBe(false);
			expect(r.err).toBe("");
		} finally {
			restore();
		}
	});

	test("an unresolved candidate is NAMED, and suppresses the no-row line that would contradict it (1226)", async () => {
		const settled: string[] = [];
		const restore = settleSeam(settled);
		try {
			const s = stub({
				"POST /items/1134/close": closed1134,
				// The server could not settle this candidate (a ref two items both name), and nothing else
				// serves 1134. The close names the row — and does NOT go on to say "no spinoff row serves it",
				// which is the line an empty resolved set would otherwise earn.
				"POST /spinoffs/serving": { spinoffs: [], unresolved: [{ id: 596, ticket_ref: "1124" }] },
			});
			const r = await runCli(freshDbPath(), ["close", "1134"], api(s));
			expect(r.code).toBe(0);
			expect(settled).toEqual([]);
			expect(r.err).toContain("spinoff #596 (ref '1124')");
			expect(r.err).not.toContain("no spinoff row serves it");
			// and it stopped there: no unfiltered list, no item read (the two reads are the token read and the settle's)
			expect(s.calls.filter((c) => c.url.includes("/spinoffs")).map((c) => c.url.endsWith("/spinoffs/serving"))).toEqual([true, true]);
		} finally {
			restore();
		}
	});

	test("a close that joins nothing SAYS so rather than returning silently (1163)", async () => {
		const settled: string[] = [];		const restore = settleSeam(settled);
		try {
			const s = stub({
				"POST /items/1134/close": closed1134,
				// the serving read is EMPTY — no row serves 1134, the old silent no-op …
				"POST /spinoffs/serving": { spinoffs: [] },
				// … while the row table shows a thread exists on this machine, so silence would read as
				// "nothing to settle". The item's record is what names the ref to have looked for.
				"GET /spinoffs": { spinoffs: [{ id: 1, ticket_ref: "9999", branch: "9999", worktree: "/w", status: "launched", t3_thread_id: "mcp:other", item_id: null }] },
				"GET /items/1134": { item: mirror1134 },
			});
			const r = await runCli(freshDbPath(), ["close", "1134"], api(s));
			expect(r.code).toBe(0);
			expect(settled).toEqual([]);
			expect(r.err).toContain("no spinoff row serves it");
			expect(r.err).toContain('"1124"');
			expect(r.out).not.toContain("settled");
		} finally {
			restore();
		}
	});

	test("a close whose item read FAILED names that, instead of reporting a clean no-op (1163)", async () => {
		const settled: string[] = [];
		const restore = settleSeam(settled);
		try {
			const s = stub({
				"POST /items/1134/close": closed1134,
				// the same shape as above, but the item cannot be read at all (no stub ⇒ the transport 404s):
				// "could not tell" is not "nothing there", and the close must say which one it hit.
				"POST /spinoffs/serving": { spinoffs: [] },
				"GET /spinoffs": { spinoffs: [{ id: 1, ticket_ref: "9999", branch: "9999", worktree: "/w", status: "launched", t3_thread_id: "mcp:other", item_id: null }] },
			});
			const r = await runCli(freshDbPath(), ["close", "1134"], api(s));
			expect(r.code).toBe(0);
			expect(settled).toEqual([]);
			expect(r.err).toContain("could not be joined");
			expect(r.err).not.toContain("no spinoff row serves it");
		} finally {
			restore();
		}
	});

	test("a serving row with NO builder thread id still gets its held sentinel note withdrawn (1205)", async () => {
		// The withdrawal needs the ARCHITECT's thread, not a builder's, so it must not sit behind the
		// no-thread-id return that skips the settle and the land reply (the 1142 field-drop case) — that
		// return would otherwise leave exactly the stale note this guard exists to withdraw.
		const settled: string[] = [];
		const cancelled: Array<{ threadId: string; queuedRunId: string }> = [];
		const restore = settleSeam(settled, {
			held: [{ queuedRunId: "run:stale", text: "ready for the gate: 1134\n  ticket:    1134\n", truncated: false }],
			cancelled,
		});
		try {
			const s = stub({
				"POST /items/1134/close": { id: "1134", status: "done", issue: null, issue_url: null, issue_state: null, already: null, skipped: "no-link", issue_error: null },
				"POST /spinoffs/serving": { spinoffs: [{ id: 7, ticket_ref: "1134", branch: "1134", worktree: "/w", status: "merged", t3_thread_id: null, item_id: "1134", launcher: "t3", repo: "/tmp/acme" }] },
				// OB-2255: the held note's thread is the ticket's team's (project acme, team acme, no sentinel)
				"GET /items/1134": { item: { id: "1134", project: "acme", tags: [] } },
				"GET /projects": { projects: [{ id: "acme", name: "acme", kind: "side", git_remote: null, created_at: "x", key: "OB", icon: null, display_name: null, stage: null, team_name: "acme" }] },
				"GET /agents": { agents: [{ id: "sentinel-acme", session_id: "sentinel-thread-1", launcher: "t3", status: "idle" }] },
			});
			const r = await runCli(freshDbPath(), ["close", "1134"], api(s));
			expect(r.code).toBe(0);
			expect(settled).toEqual([]); // nothing to settle: that row recorded no builder thread
			expect(cancelled).toEqual([{ threadId: "sentinel-thread-1", queuedRunId: "run:stale" }]);
			expect(r.out).toContain("withdrew a queued readying note for 1134");
		} finally {
			restore();
		}
	});

	test("a legacy row is joined even when a stamped row serves the same item too (1205)", async () => {
		// Rows queued before 0032 carry `item_id` NULL, so a ref the item's own record names is the only link
		// — and a fleet mid-migration has BOTH shapes for one ticket. Reading those refs only when nothing
		// matched (which is what 1163 did) missed the legacy row whenever a stamped one joined first, leaving
		// its queued note to arrive after the land. 1226 moved that resolution to the host with the store: the
		// serving answer carries both rows, and this client acts on exactly what it is told.
		const settled: string[] = [];
		const cancelled: Array<{ threadId: string; queuedRunId: string }> = [];
		const restore = settleSeam(settled, {
			held: [{ queuedRunId: "run:legacy", text: "ready for the gate: 1124\n  ticket:    1124\n", truncated: false }],
			cancelled,
		});
		try {
			const s = stub({
				"POST /items/1134/close": { id: "1134", status: "done", issue: null, issue_url: null, issue_state: null, already: null, skipped: "no-link", issue_error: null },
				"POST /spinoffs/serving": {
					spinoffs: [
						{ id: 7, ticket_ref: "1134", branch: "1134", worktree: "/w", status: "merged", t3_thread_id: "mcp:builder", item_id: "1134", launcher: "t3", repo: "/tmp/acme" },
						{ id: 8, ticket_ref: "1124", branch: "1124", worktree: "/w", status: "merged", t3_thread_id: null, item_id: null, launcher: "t3", repo: "/tmp/acme" },
					],
				},
				// OB-2255: the held note's thread is the ticket's team's (project acme, team acme, no sentinel)
				"GET /items/1134": { item: { id: "1134", project: "acme", tags: [] } },
				"GET /projects": { projects: [{ id: "acme", name: "acme", kind: "side", git_remote: null, created_at: "x", key: "OB", icon: null, display_name: null, stage: null, team_name: "acme" }] },
				"GET /agents": { agents: [{ id: "sentinel-acme", session_id: "sentinel-thread-1", launcher: "t3", status: "idle" }] },
			});
			const r = await runCli(freshDbPath(), ["close", "1134"], api(s));
			expect(r.code).toBe(0);
			expect(cancelled).toEqual([{ threadId: "sentinel-thread-1", queuedRunId: "run:legacy" }]);
			expect(settled).toEqual(["mcp:builder"]);
			// the client acts on the serving answer as given: it never re-resolves the legacy row's ref (the one item
			// read is the ticket's project, for the team thread, OB-2255)
			expect(s.calls.some((c) => c.method === "GET" && c.url.includes("/items/1124"))).toBe(false);
		} finally {
			restore();
		}
	});

	test("a failed serving read keeps what a RESOLUTION joined, and names what it cannot check (1205+1226)", async () => {
		// A failed resolution must not discard a row it can still vouch for: `item_id !== ticket_ref` is path
		// evidence (dispatch stamps the ref itself only when no item names that ticket path), so that row's
		// withdrawal, land reply and settle still happen. 1226 narrows this deliberately: a row whose ref IS
		// its own id may carry the OLD bare-id stamp — the collision this ticket fixes — and the resolution
		// that would correct it is exactly what failed, so such a row is left ALONE and named, as is a legacy
		// row (no `item_id`, joined only by the item's record this read needed). A missed settle self-heals;
		// a wrong land reply costs a real builder turn.
		const settled: string[] = [];
		const cancelled: Array<{ threadId: string; queuedRunId: string }> = [];
		const restore = settleSeam(settled, {
			held: [{ queuedRunId: "run:x", text: "ready for the gate: 1124\n", truncated: false }],
			cancelled,
		});
		try {
			const s = stub({
				"POST /items/1134/close": { id: "1134", status: "done", issue: null, issue_url: null, issue_state: null, already: null, skipped: "no-link", issue_error: null },
				// No `POST /spinoffs/serving` answer: that read 404s. The rows a RESOLUTION had joined are
				// still usable; the ones only a record or a coincidence points at are not.
				"GET /spinoffs": {
					spinoffs: [
						// a resolution chose this identity (ref 1124 → item 1134): withdrawn, told, settled
						{ id: 7, ticket_ref: "1124", branch: "1124", worktree: "/w", status: "merged", t3_thread_id: "mcp:builder", item_id: "1134", launcher: "t3", repo: "/tmp/acme" },
						// a row whose ref IS its own id: it may be an old bare-id stamp, so it is left alone
						{ id: 8, ticket_ref: "1134", branch: "1134", worktree: "/w", status: "merged", t3_thread_id: "mcp:unchecked", item_id: "1134", launcher: "t3", repo: "/tmp/acme" },
						// a legacy row: only the item's record joins it, and that is what just failed
						{ id: 9, ticket_ref: "1150", branch: "1150", worktree: "/w", status: "merged", t3_thread_id: "mcp:legacy", item_id: null, launcher: "t3", repo: "/tmp/acme" },
					],
				},
				// OB-2255: the held note's thread is the ticket's team's (project acme, team acme, no sentinel)
				"GET /items/1134": { item: { id: "1134", project: "acme", tags: [] } },
				"GET /projects": { projects: [{ id: "acme", name: "acme", kind: "side", git_remote: null, created_at: "x", key: "OB", icon: null, display_name: null, stage: null, team_name: "acme" }] },
				"GET /agents": { agents: [{ id: "sentinel-acme", session_id: "sentinel-thread-1", launcher: "t3", status: "idle" }] },
			});
			const r = await runCli(freshDbPath(), ["close", "1134"], api(s));
			expect(r.code).toBe(0);
			expect(settled).toEqual(["mcp:builder"]);
			expect(cancelled).toEqual([{ threadId: "sentinel-thread-1", queuedRunId: "run:x" }]);
			expect(r.err).toContain("could not be confirmed");
			expect(r.err).toContain("1 recording no item, 1 whose ref is also its own id");
		} finally {
			restore();
		}
	});

	test("`ob start` posts the workflow verb rather than a status column", async () => {
		const s = stub({ "POST /items/42/state": { id: "42", status: "doing" } });
		const r = await runCli(freshDbPath(), ["start", "42"], api(s));
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("42");
		expect(JSON.parse(s.calls[0]!.body!).action).toBe("start");
	});

	test("`ob block` needs its reason before anything is sent", async () => {
		const s = stub({});
		const r = await runCli(freshDbPath(), ["block", "42"], api(s));
		expect(r.code).toBe(2);
		expect(s.calls).toEqual([]);
	});

	test("`ob note` and `ob tag` reach their own endpoints", async () => {
		const notes = stub({ "POST /items/42/notes": { id: "42", body: "a note" } });
		expect((await runCli(freshDbPath(), ["note", "42", "a note"], api(notes))).code).toBe(0);
		expect(JSON.parse(notes.calls[0]!.body!).text).toBe("a note");

		const tags = stub({ "POST /items/42/tags": { id: "42", tags: ["backend"] } });
		expect((await runCli(freshDbPath(), ["tag", "42", "backend"], api(tags))).code).toBe(0);
		expect(JSON.parse(tags.calls[0]!.body!).add).toEqual(["backend"]);

		const untags = stub({ "POST /items/42/tags": { id: "42", tags: [] } });
		expect((await runCli(freshDbPath(), ["untag", "42", "backend"], api(untags))).code).toBe(0);
		expect(JSON.parse(untags.calls[0]!.body!).remove).toEqual(["backend"]);
	});

	test("`ob search` sends the query and renders the hits", async () => {
		const s = stub({ "GET /search": { query: "found", items: [view("5", "found me")], focus_project: null } });
		const r = await runCli(freshDbPath(), ["search", "found"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("found me");
		expect(s.calls[0]!.url).toContain("q=found");
	});

	test("`ob status` renders the snapshot the endpoint assembled", async () => {
		const s = stub({
			"GET /status": {
				status: {
					agents: [],
					needs_review: [],
					working: [],
					in_flight_prs: [],
					blocked: [
						{
							id: "9",
							title: "waiting on cloudflare",
							status: "blocked",
							priority: null,
							block_reason: "token scope",
							block_owner: "alex-example",
							today_rank: null,
						},
					],
					focus: [],
					frontier: null,
					journal: [],
					completed_spinoffs: [],
					frontier_note: null,
				},
			},
		});
		const r = await runCli(freshDbPath(), ["status"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("Status — what's happening now");
		expect(r.out).toContain("waiting on cloudflare — token scope (alex-example)");
	});

	test("`ob agents` renders the registry the endpoint returned", async () => {
		const s = stub({
			"GET /agents": {
				agents: [
					{
						id: "build-353",
						ticket: "353",
						worktree: null,
						branch: "build-353",
						status: "working",
						run: "running",
						note: null,
						launcher: "headless",
						session_id: null,
						started_at: "2026-08-18T00:00:00.000Z",
						heartbeat_at: "2026-08-18T00:01:00.000Z",
						ttl_s: 900,
						expired: false,
					},
				],
			},
		});
		const r = await runCli(freshDbPath(), ["agents"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("build-353");
		// 1189: the split path joins the two vocabularies the same way the local path does — ob's word, then
		// T3's run — so `ob agents` reads the same on a client as it does on the host.
		expect(r.out).toContain("working · running");
	});

	test("`ob agents reset` POSTs /agents/reset and does not refuse (437)", async () => {
		const s = stub({
			"POST /agents/reset": {
				dry_run: false,
				agents: ["ghost-a", "ghost-b"],
				leases: ["app:widget", "ticket:1"],
			},
		});
		const r = await runCli(freshDbPath(), ["agents", "reset"], api(s));
		expect(r.code).toBe(0);
		expect(r.err).not.toContain("not available");
		expect(r.err).not.toContain("refusing");
		expect(r.out).toContain("reset 2 agents, 2 leases");
		expect(r.out).toContain("app:widget");
		expect(r.out).toContain("do not kill or relaunch");
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0]!.url).toContain("/agents/reset");
		expect(s.calls[0]!.method).toBe("POST");
		expect(JSON.parse(s.calls[0]!.body!)).toEqual({ dry_run: false });
	});

	test("`ob agents reset --dry-run` sends dry_run and writes nothing here (437)", async () => {
		const s = stub({
			"POST /agents/reset": { dry_run: true, agents: ["ghost-a"], leases: ["ticket:1"] },
		});
		const r = await runCli(freshDbPath(), ["agents", "reset", "--dry-run"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("would reset 1 agents, 1 leases");
		expect(r.out).not.toContain("do not kill");
		expect(JSON.parse(s.calls[0]!.body!)).toEqual({ dry_run: true });
	});

	test("`ob agent register` resolves the CHECKOUT here and sends it, then prints the row", async () => {
		const s = stub({
			"POST /agents": {
				agent: {
					id: "build-353",
					ticket: "353",
					worktree: "/w",
					branch: "b",
					status: "working",
					note: null,
					launcher: null,
					session_id: null,
					started_at: "2026-08-18T00:00:00.000Z",
					heartbeat_at: "2026-08-18T00:00:00.000Z",
					ttl_s: 900,
				},
				found: true,
				ticket_lease: "ticket:353",
				released: [],
			},
		});
		const r = await runCli(
			freshDbPath(),
			["agent", "register", "--id", "build-353", "--ticket", "353", "--status", "working", "--worktree", "/w", "--branch", "b"],
			api(s),
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("registered build-353 — working on 353");
		const body = JSON.parse(s.calls[0]!.body!);
		expect(body.action).toBe("register");
		expect(body.worktree).toBe("/w");
		expect(body.branch).toBe("b");
	});

	test("a ticket already held comes back as the server's own refusal, holder and safe retry included", async () => {
		const transport: ApiTransport = async () => ({
			status: 409,
			body: JSON.stringify({
				error: {
					code: "refused",
					message:
						"cannot register 'b': ticket:353 held by architect-acme since 2026-08-18 (ttl 1800s). If that holder is you, register under it with --holder architect-acme",
				},
			}),
		});
		const r = await runCli(freshDbPath(), ["agent", "register", "--id", "b", "--ticket", "353"], {
			api: { base: BASE, token: TOKEN, transport },
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain("ticket:353 held by architect-acme");
		expect(r.err).toContain("--holder architect-acme");
	});

	test("`ob lease acquire` denied exits 1 and names the live holder", async () => {
		const s = stub({ "POST /leases": { resource: "ticket:353", ok: false, holder: "architect-acme" } });
		const r = await runCli(freshDbPath(), ["lease", "acquire", "ticket:353", "--holder", "me"], api(s));
		expect(r.code).toBe(1);
		expect(r.out).toContain("denied: ticket:353 held by architect-acme");
	});

	test("`ob lease run` acquires over HTTP with the 300 s default, passes the command's code through, then releases (OB-2071)", async () => {
		const s = stub({
			"POST /leases": { resource: "cpu:browser", ok: true, holder: "me" },
			"DELETE /leases/cpu%3Abrowser": { resource: "cpu:browser", released: true },
		});
		const r = await runCli(freshDbPath(), ["lease", "run", "cpu:browser", "--holder", "me", "--", "sh", "-c", "exit 3"], api(s));
		expect(r.code).toBe(3);
		expect(s.calls.map((c) => c.method + " " + c.url.slice((BASE + OB_API_PREFIX).length))).toEqual([
			"POST /leases",
			"DELETE /leases/cpu%3Abrowser?holder=me",
		]);
		expect(JSON.parse(s.calls[0]!.body!)).toMatchObject({ resource: "cpu:browser", holder: "me", ttl_s: 300 });
	});

	test("`ob lease release` that released nothing is a failure the caller sees", async () => {
		const s = stub({ "DELETE /leases/ticket%3A353": { resource: "ticket:353", released: false } });
		const r = await runCli(freshDbPath(), ["lease", "release", "ticket:353", "--holder", "me"], api(s));
		expect(r.code).toBe(1);
		expect(r.out).toContain("nothing released");
		expect(s.calls[0]!.url).toContain("holder=me");
	});

	test("a release the server DID name a row for prints #75's teaching message", async () => {
		const s = stub({
			"DELETE /leases/ticket%3A353": {
				resource: "ticket:353",
				released: false,
				recorded: { resource: "ticket:353", holder: "someone-else", since: null, ttl_s: 1800, expired: false },
			},
		});
		const r = await runCli(freshDbPath(), ["lease", "release", "ticket:353", "--holder", "me"], api(s));
		expect(r.code).toBe(1);
		expect(r.out).toContain("is held by someone-else, not me, nothing released");
		expect(r.out).toContain("--holder someone-else");
	});

	test("`ob lease status` reads the lease table over HTTP", async () => {
		const s = stub({
			"GET /leases": {
				leases: [
					{
						resource: "ticket:353",
						holder: "me",
						acquired_at: "2026-08-18T00:00:00.000Z",
						ttl_s: 1800,
						heartbeat_at: "2026-08-18T00:05:00.000Z",
						expired: false,
					},
				],
			},
		});
		const r = await runCli(freshDbPath(), ["lease", "status"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("ticket:353\theld\tme");
		// OB-1922: this stub predates the sweep (404), and status still reads
		expect(r.err).toContain("expired leases not swept");
	});

	test("`ob lease status` sweeps first over HTTP and names what it swept (OB-1922)", async () => {
		const s = stub({ "POST /leases/sweep": { swept: ["ticket:old"] }, "GET /leases": { leases: [] } });
		const r = await runCli(freshDbPath(), ["lease", "status"], api(s));
		expect(r.code).toBe(0);
		expect(s.calls.map((c) => c.method + " " + c.url.slice((BASE + OB_API_PREFIX).length))).toEqual([
			"POST /leases/sweep",
			"GET /leases",
		]);
		expect(r.err).toContain("swept 1 lease(s) expired for over a day: ticket:old");
	});
});

describe("failures say what happened, and never say the token (353)", () => {
	test("an unreachable API is an error, not a quiet fall back to a database", async () => {
		const calls: ApiRequest[] = [];
		const transport: ApiTransport = async (req) => {
			calls.push(req);
			throw new Error("connect ECONNREFUSED 10.0.0.130:5050");
		};
		const r = await runCli(freshDbPath(), ["next"], { api: { base: BASE, token: TOKEN, transport } });
		expect(r.code).toBe(1);
		expect(r.err).toContain("could not reach the ob API");
		expect(r.err).toContain("no local database path to fall back to");
	});

	test("a transport error that echoes the request back has the token stripped out of it", async () => {
		const transport: ApiTransport = async () => {
			throw new Error(`request failed: Authorization: Bearer ${TOKEN}`);
		};
		const r = await runCli(freshDbPath(), ["next"], { api: { base: BASE, token: TOKEN, transport } });
		expect(r.code).toBe(1);
		expect(r.err).not.toContain(TOKEN);
		expect(r.err).toContain("<redacted>");
	});

	test("a rejected token says so without printing it", async () => {
		const transport: ApiTransport = async () => ({
			status: 401,
			body: JSON.stringify({ error: { code: "unauthorized", message: "unauthorized" } }),
		});
		const r = await runCli(freshDbPath(), ["next"], { api: { base: BASE, token: TOKEN, transport } });
		expect(r.code).toBe(1);
		expect(r.err).toContain("rejected this token");
		expect(r.err).not.toContain(TOKEN);
	});

	test("a server with no token file of its own says so, and says it is not this machine's to fix", async () => {
		const transport: ApiTransport = async () => ({
			status: 503,
			body: JSON.stringify({ error: { code: "api_disabled", message: "no API token file at /etc/omnislash/api_token" } }),
		});
		const r = await runCli(freshDbPath(), ["next"], { api: { base: BASE, token: TOKEN, transport } });
		expect(r.code).toBe(1);
		expect(r.err).toContain("no API token file at /etc/omnislash/api_token");
		expect(r.err).toContain("nothing here will fix it");
	});

	test("an unknown endpoint lists what IS served, so a drifted client finds out from the server", async () => {
		const transport: ApiTransport = async () => ({
			status: 404,
			body: JSON.stringify({
				error: { code: "unknown_endpoint", message: "GET /api/ob/nope is not served", served: ["GET /api/ob/next  -- the worklist"] },
			}),
		});
		const r = await runCli(freshDbPath(), ["next"], { api: { base: BASE, token: TOKEN, transport } });
		expect(r.code).toBe(1);
		expect(r.err).toContain("this API serves:");
		expect(r.err).toContain("GET /api/ob/next");
	});

	test("the server's error envelope is what the human reads", async () => {
		const transport: ApiTransport = async () => ({
			status: 404,
			body: JSON.stringify({ error: { code: "not_found", message: "no item '999'" } }),
		});
		const r = await runCli(freshDbPath(), ["show", "999"], { api: { base: BASE, token: TOKEN, transport } });
		expect(r.code).toBe(1);
		expect(r.err).toContain("no item '999'");
	});

	test("redactToken removes every occurrence", () => {
		expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe("a <redacted> b <redacted>");
	});
});

describe("`ob config` over HTTP (the server stays the source of truth)", () => {
	test("`ob config get <k>` asks for one key and prints its value (empty when absent)", async () => {
		const s = stub({ "GET /config": { config: [{ key: "spinoff_engine", value: "claude" }] } });
		const r = await runCli(freshDbPath(), ["config", "get", "spinoff_engine"], api(s));
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("claude");
		expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/config?key=spinoff_engine`);

		const s2 = stub({ "GET /config": { config: [{ key: "nope", value: null }] } });
		const r2 = await runCli(freshDbPath(), ["config", "get", "nope"], api(s2));
		expect(r2.code).toBe(0);
		expect(r2.out).toBe("");
	});

	test("`ob config set <k> <v>` posts the key/value and prints the value back", async () => {
		const s = stub({ "POST /config": { key: "spinoff_engine", value: "opencode" } });
		const r = await runCli(freshDbPath(), ["config", "set", "spinoff_engine", "opencode"], api(s));
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("opencode");
		expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/config`);
		expect(JSON.parse(s.calls[0]!.body!)).toEqual({ key: "spinoff_engine", value: "opencode" });
	});

	test("`ob config` lists the table as key=value lines, and --json as JSON", async () => {
		const s = stub({ "GET /config": { config: [{ key: "a", value: "1" }, { key: "b", value: null }] } });
		const r = await runCli(freshDbPath(), ["config"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("a=1");
		expect(r.out).toContain("b=");

		const j = await runCli(freshDbPath(), ["config", "--json"], api(stub({ "GET /config": { config: [{ key: "a", value: "1" }] } })));
		expect(JSON.parse(j.out)).toEqual([{ key: "a", value: "1" }]);
	});

	test("`ob config` REFUSES remote_host -- it is the client's own pointer, not a server setting", async () => {
		for (const argv of [
			["config", "get", "remote_host"],
			["config", "set", "remote_host", "ob@host"],
		]) {
			const s = stub({});
			const r = await runCli(freshDbPath(), argv, api(s));
			expect(r.code).toBe(2);
			expect(r.err).toContain("THIS machine's API pointer");
			expect(s.calls).toEqual([]);
		}
	});

	test("a missing key is a usage error before any request", async () => {
		const s = stub({});
		const r = await runCli(freshDbPath(), ["config", "get"], api(s));
		expect(r.code).toBe(2);
		expect(s.calls).toEqual([]);
	});
});

describe("`ob issue` over HTTP (169: the pairing half; 389 serves landed/drift/reconcile)", () => {
	test("`ob issue list` reads the pairs and renders id, issue, status, title", async () => {
		const s = stub({
			"GET /issues": {
				issues: [{ id: "369", status: "open", title: "the opencode migration", issue: 166, repo: "owner/acme" }],
			},
		});
		const r = await runCli(freshDbPath(), ["issue", "list"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("ob 369");
		expect(r.out).toContain("#166");
		expect(r.out).toContain("the opencode migration");
		expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/issues`);
	});

	test("`ob issue link <id> #n` parses the number and posts it; a URL carries its repo across", async () => {
		const s = stub({
			"POST /issues/link": { id: "369", issue: 166, repo: "owner/acme", url: "https://github.com/owner/acme/issues/166" },
		});
		const r = await runCli(freshDbPath(), ["issue", "link", "369", "#166"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("ob 369 <-> issue #166");
		expect(JSON.parse(s.calls[0]!.body!)).toEqual({ item_id: "369", number: 166, repo: null });

		// A URL carries its own repo; a bare number leaves it null for the server to default.
		const s2 = stub({
			"POST /issues/link": { id: "369", issue: 166, repo: "owner/acme", url: "https://github.com/owner/acme/issues/166" },
		});
		const r2 = await runCli(freshDbPath(), ["issue", "link", "369", "https://github.com/owner/acme/issues/166"], api(s2));
		expect(r2.code).toBe(0);
		expect(JSON.parse(s2.calls[0]!.body!)).toEqual({ item_id: "369", number: 166, repo: "owner/acme" });
	});

	test("`ob issue unlink <id>` posts the item and renders what was cleared", async () => {
		const s = stub({
			"POST /issues/unlink": { id: "369", kind: "issue", issue: 166, linear_id: null, url: "https://github.com/owner/acme/issues/166" },
		});
		const r = await runCli(freshDbPath(), ["issue", "unlink", "369"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("ob 369 no longer linked to issue #166");
		expect(JSON.parse(s.calls[0]!.body!)).toEqual({ item_id: "369" });
	});

	test("`ob issue reconcile` asks the endpoint (389: GitHub cred is on the host)", async () => {
		const s = stub({ "GET /issues/reconcile": { repo: "owner/acme", candidates: [] } });
		const r = await runCli(freshDbPath(), ["issue", "reconcile"], api(s));
		expect(r.code).toBe(0);
		expect(r.out).toContain("No likely unlinked");
		expect(s.calls[0]!.url).toContain("/issues/reconcile");
		expect(r.err).not.toContain("run it on the API host");
	});
});

describe("an API client opens no database (353, map decision D2)", () => {
	test("a routed command never touches the database path it was given", async () => {
		const path = join(tmpdir(), `ob-api-never-created-${Math.random().toString(36).slice(2)}.sqlite`);
		const s = stub({ "GET /next": { items: [], triage_count: 0, focus_project: null } });
		const r = await runCli(path, ["next"], api(s));
		expect(r.code).toBe(0);
		expect(existsSync(path)).toBe(false);
	});

	test("the base url is what makes a machine a client, on the LAN and off it: there is no second mode", () => {
		// The whole of D2 in one assertion: nothing in the resolver asks where the machine is.
		const prev = process.env[API_BASE_ENV];
		process.env[API_BASE_ENV] = BASE;
		try {
			expect(resolveApiBase()).toBe(BASE);
		} finally {
			if (prev === undefined) delete process.env[API_BASE_ENV];
			else process.env[API_BASE_ENV] = prev;
		}
	});
});

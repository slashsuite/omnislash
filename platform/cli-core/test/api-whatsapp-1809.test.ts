// OB-1809 -- the rest of `ob whatsapp` from an API client. The bridge is on the server, so nothing here needs ssh.
//
// What must not change is the send's safety line: a human confirms the exact text and recipient on the terminal they
// are at, before any request exists, and the server refuses a body that does not say so. Hermetic: the client goes
// through a stub transport, the bridge is a fake fetch, and the store is the throwaway Postgres cluster.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { hostJobArgv, parseHostJobRequest } from "../../../apps/cli/src/api/host-jobs.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";

const BASE = "https://ob.example.test";
const TOKEN = "a-test-bearer-token-that-is-long-enough";
const JID = "27000000003@s.whatsapp.net";
const SENT = { ok: true, to: JID, response: { success: true }, id: null };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-1809-wa-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stub(answer: (req: ApiRequest, n: number) => { status: number; body: unknown } | Error = () => ({ status: 200, body: SENT })) {
	const calls: ApiRequest[] = [];
	const transport: ApiTransport = async (req) => {
		calls.push(req);
		const out = answer(req, calls.length);
		if (out instanceof Error) throw out;
		return { status: out.status, body: JSON.stringify(out.body) };
	};
	return { calls, api: { base: BASE, token: TOKEN, transport } };
}
const paths = (calls: ApiRequest[]) => calls.map((c) => `${c.method} ${c.url.slice((BASE + OB_API_PREFIX).length)}`);
const bodyOf = (c: ApiRequest | undefined) => JSON.parse(c!.body!);

/** The human at the keyboard: waits for the prompt to be listening, then answers it or closes stdin. */
async function answerPrompt(answer: string | null): Promise<void> {
	while (process.stdin.listenerCount("data") === 0) await Bun.sleep(1);
	if (answer === null) process.stdin.emit("end");
	else process.stdin.emit("data", Buffer.from(`${answer}\n`));
}

describe("ob whatsapp send over the API: the human gate", () => {
	const send = ["whatsapp", "send", "--to", JID, "--body", "see you at 6"];

	test("a declined prompt, or a closed stdin, makes no request at all", async () => {
		for (const answer of ["n", "", null]) {
			const s = stub();
			const run = runCli(freshDbPath(), send, { api: s.api });
			await answerPrompt(answer);
			const r = await run;
			expect(r.code).toBe(0);
			expect(r.err).toContain("nothing sent");
			expect(s.calls).toEqual([]);
		}
	});

	test("the human sees the exact recipient and text before anything goes, and those exact bytes go", async () => {
		const body = "  two spaces, then\na second line  ";
		const s = stub();
		const r = await runCli(freshDbPath(), ["whatsapp", "send", "--to", JID, "--body", body, "--yes"], { api: s.api });
		expect(r.code).toBe(0);
		expect(r.err).toContain(`to:   ${JID}`);
		expect(r.err).toContain(`body: ${body}`);
		expect(paths(s.calls)).toEqual(["POST /whatsapp/send"]);
		expect(bodyOf(s.calls[0])).toEqual({ to: JID, body, confirm: true });
		expect(r.out).toContain(`sent to ${JID}`);
	});

	test("a lost answer is not retried, and says to look before sending again", async () => {
		for (const answer of [() => new Error("timed out"), () => ({ status: 502, body: { error: { message: "bad gateway" } } })]) {
			const s = stub(answer);
			const r = await runCli(freshDbPath(), [...send, "--yes"], { api: s.api });
			expect(r.code).toBe(1);
			expect(r.err).toContain("check ob whatsapp recent");
			expect(s.calls).toHaveLength(1);
		}
	});

	test("usage and a file off the allow-list refuse before the prompt", async () => {
		const key = join(dir, "id_ed25519");
		writeFileSync(key, "secret");
		for (const [args, code] of [
			[["whatsapp", "send", "--body", "x"], 2],
			[["whatsapp", "send", "--to", JID], 2],
			[["whatsapp", "send", "--to", JID, "--file", key], 1],
		] as const) {
			const s = stub();
			const r = await runCli(freshDbPath(), [...args], { api: s.api });
			expect(r.code).toBe(code);
			expect(r.err).not.toContain("Send this message");
			expect(s.calls).toEqual([]);
		}
	});

	test("files go one request each, the caption on the first, and a failure stops the rest and says how far it got", async () => {
		const a = join(dir, "a.pdf");
		const b = join(dir, "b.png");
		const c = join(dir, "c.png");
		for (const f of [a, b, c]) writeFileSync(f, `bytes of ${f}`);
		const args = ["whatsapp", "send", "--to", JID, "--body", "cap", "--file", a, "--file", b, "--file", c, "--yes"];

		const ok = stub();
		expect((await runCli(freshDbPath(), args, { api: ok.api })).code).toBe(0);
		expect(ok.calls.map((x) => bodyOf(x).body)).toEqual(["cap", "", ""]);
		expect(bodyOf(ok.calls[1]).file).toEqual({ name: "b.png", data_base64: Buffer.from(`bytes of ${b}`).toString("base64") });

		const refused = stub((_, n) => (n === 2 ? { status: 409, body: { error: { message: "bridge said no" } } } : { status: 200, body: SENT }));
		const r = await runCli(freshDbPath(), args, { api: refused.api });
		expect(r.code).toBe(1);
		expect(r.err).toContain("sent 1 of 3 files");
		expect(r.err).toContain("b.png was not sent");
		expect(r.err).toContain(`ob whatsapp send --to ${JID} --file ${b} --file ${c}`);
		expect(refused.calls).toHaveLength(2);

		const lost = stub((_, n) => (n === 2 ? new Error("timed out") : { status: 200, body: SENT }));
		expect((await runCli(freshDbPath(), args, { api: lost.api })).err).toContain("b.png may have gone");
	});

	test("OB-1909: --resend rides in the body, and the host's may-already-have-gone refusal is shown as it is (plus what went)", async () => {
		const a = join(dir, "a.pdf");
		const b = join(dir, "b.png");
		for (const f of [a, b]) writeFileSync(f, `bytes of ${f}`);
		const ok = stub();
		await runCli(freshDbPath(), ["whatsapp", "send", "--to", JID, "--body", "x", "--resend", "--yes"], { api: ok.api });
		expect(bodyOf(ok.calls[0])).toEqual({ to: JID, body: "x", confirm: true, resend: true });

		const msg = "an identical WhatsApp send may already have gone; --resend sends it anyway.";
		const refused = stub((_, n) => (n === 2 ? { status: 409, body: { error: { message: msg } } } : { status: 200, body: SENT }));
		const r = await runCli(freshDbPath(), ["whatsapp", "send", "--to", JID, "--file", a, "--file", b, "--yes"], { api: refused.api });
		expect(r.code).toBe(1);
		expect(r.err).toContain(msg);
		expect(r.err).toContain("sent 1 of 2 files");
		expect(r.err).toContain(`ob whatsapp send --to ${JID} --file ${b} --resend`);

		const first = stub(() => ({ status: 409, body: { error: { message: msg } } }));
		const r1 = await runCli(freshDbPath(), ["whatsapp", "send", "--to", JID, "--file", a, "--file", b, "--yes"], { api: first.api });
		expect(r1.err).toContain(msg);
		expect(r1.err).not.toContain("sent 0 of 2 files");
	});

	test("a file too big for the API refuses before the human is asked", async () => {
		const big = join(dir, "big.pdf");
		writeFileSync(big, Buffer.alloc(11_900_001));
		const s = stub();
		const r = await runCli(freshDbPath(), ["whatsapp", "send", "--to", JID, "--file", big, "--yes"], { api: s.api });
		expect(r.code).toBe(1);
		expect(r.err).toContain("over the 11900000 byte limit");
		expect(s.calls).toEqual([]);
	});
});

describe("the other whatsapp commands, client side", () => {
	test("bio: show, set and clear are the self_bio config key", async () => {
		const s = stub((req) => ({ status: 200, body: req.method === "GET" ? { config: [{ key: "self_bio", value: null }] } : { key: "self_bio", value: "x" } }));
		expect((await runCli(freshDbPath(), ["whatsapp", "bio"], { api: s.api })).out).toContain("no self-bio set");
		expect((await runCli(freshDbPath(), ["whatsapp", "bio", "I", "build", "things"], { api: s.api })).out).toContain("self-bio set:\nI build things");
		expect((await runCli(freshDbPath(), ["whatsapp", "bio", "--clear"], { api: s.api })).out).toContain("self-bio cleared");
		expect(s.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
		expect(bodyOf(s.calls[1])).toEqual({ key: "self_bio", value: "I build things" });
		expect(bodyOf(s.calls[2])).toEqual({ key: "self_bio", value: null });
	});

	test("every pref posts its action; the bare forms list; the rest need a jid", async () => {
		for (const action of ["hide", "show", "ai-off", "ai-on", "favorite", "unfavorite"]) {
			const s = stub(() => ({ status: 200, body: { chat_jid: JID, hidden: true, ai_disabled: false, favorite: false } }));
			const r = await runCli(freshDbPath(), ["whatsapp", action, JID], { api: s.api });
			expect(r.code).toBe(0);
			expect(r.out).toContain(`${JID} — hidden, AI on, not favourite`);
			expect(bodyOf(s.calls[0])).toEqual({ chat_jid: JID, action });
		}
		const list = stub(() => ({ status: 200, body: { chats: [] } }));
		expect((await runCli(freshDbPath(), ["whatsapp", "show"], { api: list.api })).out).toContain("no hidden chats");
		expect((await runCli(freshDbPath(), ["whatsapp", "favorite"], { api: list.api })).out).toContain("no favourite chats");
		expect(paths(list.calls)).toEqual(["GET /whatsapp/prefs/hidden", "GET /whatsapp/prefs/favorites"]);
		for (const action of ["hide", "ai-off", "ai-on", "unfavorite"]) {
			const s = stub();
			const r = await runCli(freshDbPath(), ["whatsapp", action], { api: s.api });
			expect(r.code).toBe(2);
			expect(s.calls).toEqual([]);
		}
	});

	test("bridge status, bare or named, is a host job and not a refusal", async () => {
		for (const args of [["whatsapp", "bridge"], ["whatsapp", "bridge", "status"]]) {
			const s = stub(() => ({ status: 404, body: { error: { message: "older server" } } }));
			await runCli(freshDbPath(), args, { api: s.api });
			expect(paths(s.calls)[0]).toBe("POST /host-jobs");
			expect(bodyOf(s.calls[0]).kind).toBe("whatsapp-bridge-status");
		}
	});

	test("sync is a closed host job: only its own typed options reach the child", () => {
		expect(hostJobArgv(parseHostJobRequest({ kind: "whatsapp-bridge-status" }))).toEqual(["whatsapp", "bridge", "status"]);
		expect(hostJobArgv(parseHostJobRequest({ kind: "whatsapp-sync" }))).toEqual(["whatsapp", "sync"]);
		expect(
			hostJobArgv(parseHostJobRequest({ kind: "whatsapp-sync", options: { backfill: true, since: "-7d", max: "50" } })),
		).toEqual(["whatsapp", "sync", "--backfill", "--since=-7d", "--max=50"]);
		for (const options of [{ since: true }, { days: {} }, { dryRun: "x" }]) {
			expect(() => hostJobArgv(parseHostJobRequest({ kind: "whatsapp-sync", options }))).toThrow();
		}
		// The option names are per kind: another job does not gain these.
		expect(() => hostJobArgv(parseHostJobRequest({ kind: "backup", options: { since: "-7d" } }))).toThrow("does not take");
	});
});

describe("the server half", () => {
	interface Sent {
		url: string;
		auth: string | null;
		body: { recipient: string; message: string; media_path?: string };
		media?: string;
	}

	async function withApi(fn: (ctx: { store: Store; sent: Sent[]; call: (path: string, body?: unknown, token?: string | null) => Promise<{ status: number; body: any }> }) => Promise<void>) {
		const lease = await leaseRealPgDb();
		const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
		const sent: Sent[] = [];
		const api = createObApi({
			store: async () => store,
			token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
			whatsappSend: {
				fetch: (async (url: string, init: { body: string; headers: Record<string, string> }) => {
					const body = JSON.parse(init.body);
					sent.push({
						url: String(url),
						auth: init.headers.authorization ?? null,
						body,
						// Read during the send: the bridge reads this path while the request is open.
						...(body.media_path ? { media: readFileSync(body.media_path, "utf8") } : {}),
					});
					if (body.message === "bridge-500") return new Response(JSON.stringify({ success: false, message: "boom" }), { status: 500 });
					return new Response(JSON.stringify({ success: true, message: "sent" }), { status: 200 });
				}) as unknown as typeof fetch,
			},
		});
		const call = async (path: string, body?: unknown, token: string | null = TOKEN) => {
			const res = await api(
				new Request(`http://api-host.local${OB_API_PREFIX}${path}`, {
					method: body === undefined ? "GET" : "POST",
					headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
			return { status: res.status, body: await res.json() };
		};
		writeFileSync(join(dir, ".bridge-token"), "bridge-token\n");
		await setConfig(store, "whatsapp_bridge_token_path", join(dir, ".bridge-token"));
		await setConfig(store, "whatsapp_bridge_url", "http://bridge.test:8080");
		await setConfig(store, "whatsapp_db_path", join(dir, "no-messages.db"));
		try {
			await fn({ store, sent, call });
		} finally {
			await store.close();
			await lease.release();
		}
	}

	test("send: nothing without a bearer token or a literal confirm:true; with both, the exact text reaches the bridge", async () => {
		await withApi(async ({ sent, call }) => {
			expect((await call("/whatsapp/send", { to: JID, body: "x", confirm: true }, null)).status).toBe(401);
			for (const confirm of [undefined, false, "true", 1]) {
				const res = await call("/whatsapp/send", { to: JID, body: "x", confirm });
				expect(res.status).toBe(400);
				expect(res.body.error.message).toContain("confirm:true");
			}
			expect((await call("/whatsapp/send", { to: JID, confirm: true })).status).toBe(400);
			expect(sent).toEqual([]);

			const body = "  keep\nthis  ";
			const ok = await call("/whatsapp/send", { to: JID, body, confirm: true });
			expect(ok.status).toBe(200);
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({ url: "http://bridge.test:8080/api/send", auth: "Bearer bridge-token", body: { recipient: JID, message: body } });
		});
	});

	test("send: a file reaches the bridge as a private temp path, is checked, and is gone afterwards", async () => {
		await withApi(async ({ sent, call }) => {
			const data_base64 = Buffer.from("pdf bytes").toString("base64");
			const ok = await call("/whatsapp/send", { to: JID, body: "", confirm: true, file: { name: "invoice.pdf", data_base64 } });
			expect(ok.status).toBe(200);
			expect(sent[0]!.media).toBe("pdf bytes");
			expect(sent[0]!.body.media_path!.endsWith("/invoice.pdf")).toBe(true);
			expect(existsSync(sent[0]!.body.media_path!)).toBe(false);

			const bad = [
				[{ name: "../../evil.pdf", data_base64 }, 400],
				[{ name: "..", data_base64 }, 400],
				[{ name: "a.pdf", data_base64: "not base64!" }, 400],
				[{ name: "id_ed25519", data_base64 }, 409],
				[{ name: "empty.pdf", data_base64: "" }, 400],
			] as const;
			for (const [file, status] of bad) {
				expect((await call("/whatsapp/send", { to: JID, confirm: true, file })).status).toBe(status);
			}
			expect(sent).toHaveLength(1);
		});
	});

	test("the config route unsets on null and still refuses an empty value, the bio --clear path", async () => {
		await withApi(async ({ call }) => {
			expect((await call("/config", { key: "self_bio", value: "I build things" })).status).toBe(200);
			expect((await call("/config", { key: "self_bio", value: "" })).status).toBe(400);
			expect((await call("/config", { key: "self_bio" })).status).toBe(400);
			expect((await call("/config", { key: "self_bio", value: null })).status).toBe(200);
			expect((await call("/config?key=self_bio")).body.config).toEqual([{ key: "self_bio", value: null }]);
		});
	});

	test("a bridge 5xx is an unknown outcome (502), so the client never says not sent", async () => {
		await withApi(async ({ call }) => {
			expect((await call("/whatsapp/send", { to: JID, body: "bridge-500", confirm: true })).status).toBe(502);
		});
	});

	test("OB-1909: after a 5xx an identical send is a 409 that names --resend, and resend:true reaches the bridge", async () => {
		await withApi(async ({ sent, call }) => {
			expect((await call("/whatsapp/send", { to: JID, body: "bridge-500", confirm: true })).status).toBe(502);
			const again = await call("/whatsapp/send", { to: JID, body: "bridge-500", confirm: true });
			expect(again.status).toBe(409);
			expect(again.body.error.message).toContain("--resend sends it anyway.");
			expect(sent).toHaveLength(1);
			expect((await call("/whatsapp/send", { to: JID, body: "bridge-500", confirm: true, resend: true })).status).toBe(502);
			expect(sent).toHaveLength(2);
		});
	});

	test("prefs round-trip through the store", async () => {
		await withApi(async ({ call }) => {
			expect((await call("/whatsapp/prefs", { chat_jid: JID, action: "reboot" })).status).toBe(400);
			expect((await call("/whatsapp/prefs", { chat_jid: JID, action: "hide" })).body).toMatchObject({ chat_jid: JID, hidden: true });
			expect((await call("/whatsapp/prefs", { chat_jid: JID, action: "favorite" })).body).toMatchObject({ favorite: true });
			expect((await call("/whatsapp/prefs/hidden")).body.chats).toHaveLength(1);
			expect((await call("/whatsapp/prefs/favorites")).body.chats).toHaveLength(1);
		});
	});
});

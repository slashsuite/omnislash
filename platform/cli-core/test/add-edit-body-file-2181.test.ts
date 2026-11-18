import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { rewriteAddProjectArgv } from "../../../apps/cli/src/commands/capture.ts";

// OB-2181 — on the API client, `ob add 'x' --body-file <file>` must send the FILE'S TEXT as the body (the
// server cannot read the caller's path), `ob edit` must do the same, and a flag add or edit does not read is
// refused by name before any request leaves. Stubbed transport: no network, no token file, no database.

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

function stub(answers: Record<string, unknown>) {
	const calls: ApiRequest[] = [];
	const transport: ApiTransport = async (req) => {
		calls.push(req);
		const suffix = req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!;
		const key = `${req.method} ${suffix}`;
		if (!(key in answers)) {
			return { status: 404, body: JSON.stringify({ error: { code: "unknown_endpoint", message: key } }) };
		}
		return { status: 200, body: JSON.stringify(answers[key]) };
	};
	return { transport, calls };
}

function api(transport: ApiTransport) {
	return { api: { base: BASE, token: TOKEN, transport } };
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
		created_at: "2026-11-15T00:00:00.000Z",
		updated_at: "2026-11-15T00:00:00.000Z",
		closed_at: null,
	};
}

function withFile(text: string, run: (file: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "ob-2181-api-"));
	const file = join(dir, "body.md");
	writeFileSync(file, text);
	return run(file).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("ob add and ob edit read --body-file on the API client (OB-2181)", () => {
	test("add posts the file's text as the body", async () => {
		await withFile("from the file\n", async (file) => {
			const s = stub({ "POST /items": { id: "99", item: view("99", "x") } });
			const r = await runCli(freshDbPath(), ["add", "x", "--project", "acme", "--body-file", file], api(s.transport));
			expect(r.code).toBe(0);
			expect(JSON.parse(s.calls[0]!.body!).body).toBe("from the file\n");
		});
	});

	test("edit posts the file's text as the body", async () => {
		await withFile("replaced", async (file) => {
			const s = stub({ "POST /items/42/edit": { id: "42", ref: "OB-42" } });
			const r = await runCli(freshDbPath(), ["edit", "42", "--body-file", file], api(s.transport));
			expect(r.code).toBe(0);
			expect(JSON.parse(s.calls[0]!.body!).body).toBe("replaced");
		});
	});

	test("--body with --body-file is refused before any request", async () => {
		await withFile("x", async (file) => {
			const s = stub({});
			const add = await runCli(freshDbPath(), ["add", "x", "--project", "acme", "--body", "a", "--body-file", file], api(s.transport));
			expect(add.code).not.toBe(0);
			expect(add.err).toContain("not both");
			const edit = await runCli(freshDbPath(), ["edit", "42", "--body", "a", "--body-file", file], api(s.transport));
			expect(edit.code).not.toBe(0);
			expect(edit.err).toContain("not both");
			expect(s.calls).toEqual([]);
		});
	});

	test("an unreadable --body-file is refused naming the path, before any request", async () => {
		const s = stub({});
		const missing = join(tmpdir(), "ob-2181-no-such-file.md");
		const r = await runCli(freshDbPath(), ["add", "x", "--project", "acme", "--body-file", missing], api(s.transport));
		expect(r.code).not.toBe(0);
		expect(r.err).toContain(missing);
		expect(s.calls).toEqual([]);
	});

	test("a flag add does not take is refused by name, before any request", async () => {
		const s = stub({ "POST /items": { id: "99", item: view("99", "x") } });
		const r = await runCli(freshDbPath(), ["add", "x", "--project", "acme", "--subject", "y"], api(s.transport));
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob add does not take --subject");
		expect(s.calls).toEqual([]);
	});

	test("a detail flag on a type that does not take it is refused by name, before any request", async () => {
		const s = stub({ "POST /items": { id: "99", item: view("99", "x") } });
		const r = await runCli(freshDbPath(), ["add", "x", "--project", "acme", "--choice", "c"], api(s.transport));
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob add does not take --choice");
		expect(s.calls).toEqual([]);
	});

	test("a flag edit does not take is refused by name, before any request", async () => {
		const s = stub({ "POST /items/42/edit": { id: "42", ref: "OB-42" } });
		const r = await runCli(freshDbPath(), ["edit", "42", "--subject", "y"], api(s.transport));
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob edit does not take --subject");
		expect(s.calls).toEqual([]);
	});

	test("--json still works on add over the API", async () => {
		const s = stub({ "POST /items": { id: "99", item: view("99", "x") } });
		const r = await runCli(freshDbPath(), ["add", "x", "--project", "acme", "--json"], api(s.transport));
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out).id).toBe("99");
	});

	test("--kind is refused on the API with its reason, before any request", async () => {
		const s = stub({ "POST /items": { id: "99", item: view("99", "x") } });
		const r = await runCli(freshDbPath(), ["add", "x", "--project", "acme", "--kind", "side"], api(s.transport));
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("'ob add --kind' is not available through the ob API");
		expect(s.calls).toEqual([]);
	});
});

describe("--body-file over remote_host is read on this machine and sent inline (OB-2181)", () => {
	test("add and edit carry the file's text as --body=<text>, not the path", () => {
		const dir = mkdtempSync(join(tmpdir(), "ob-2181-rw-"));
		try {
			const file = join(dir, "body.md");
			writeFileSync(file, "the text");
			const add = rewriteAddProjectArgv({
				argv: ["add", "x", "--body-file", file, "--project", "acme"],
				command: "add",
				flags: { "body-file": file, project: "acme" },
			});
			expect(add.error).toBeNull();
			expect(add.argv).toEqual(["add", "x", "--body=the text", "--project", "acme"]);
			const edit = rewriteAddProjectArgv({
				argv: ["edit", "42", `--body-file=${file}`],
				command: "edit",
				flags: { "body-file": file },
			});
			expect(edit.error).toBeNull();
			expect(edit.argv).toEqual(["edit", "42", "--body=the text"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unreadable file is refused naming the path, and a too-large one is refused, never sent", () => {
		const missing = join(tmpdir(), "ob-2181-rw-missing.md");
		const unreadable = rewriteAddProjectArgv({
			argv: ["edit", "42", "--body-file", missing],
			command: "edit",
			flags: { "body-file": missing },
		});
		expect(unreadable.error).toContain(missing);
		expect(unreadable.argv).toEqual(["edit", "42", "--body-file", missing]);

		const dir = mkdtempSync(join(tmpdir(), "ob-2181-big-"));
		try {
			// 33,000 apostrophes are 33 KB of text but 132 KB once the ssh hop shell-quotes them: the check is on that.
			const big = join(dir, "big.md");
			writeFileSync(big, "'".repeat(33_000));
			const r = rewriteAddProjectArgv({
				argv: ["add", "x", "--body-file", big],
				command: "add",
				flags: { "body-file": big },
			});
			expect(r.error).toContain("too large to send over ssh");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a flag the command does not read is refused on this machine, before the ssh hop", () => {
		const r = rewriteAddProjectArgv({
			argv: ["edit", "42", "--subject", "y"],
			command: "edit",
			flags: { subject: "y" },
		});
		expect(r.error).toContain("ob edit does not take --subject");
	});
});

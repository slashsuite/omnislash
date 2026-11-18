import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "./helpers.ts";

// OB-2181 — `ob add 'x' --body-file <file>` was accepted and silently dropped: the global parser knows
// every command's flags, and `add` read only `--body`. The store path pinned here: --body-file is read
// (add and edit), a flag add or edit does not read is refused by name before anything is written, and an
// unreadable file or --body together with --body-file refuses before an item (or a GitHub issue) exists.

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "ob-2181-"));
}

async function addItem(db: string, args: string[]): Promise<string> {
	const r = await runCli(db, ["add", ...args, "--project", "omnislash", "--json"]);
	expect(r.code).toBe(0);
	return JSON.parse(r.out).id as string;
}

async function bodyOf(db: string, id: string): Promise<unknown> {
	const r = await runCli(db, ["show", id, "--json"]);
	expect(r.code).toBe(0);
	return JSON.parse(r.out).body ?? null;
}

describe("ob add and ob edit read --body-file on the store path (OB-2181)", () => {
	test("add stores the file's text as the body", async () => {
		const dir = scratch();
		try {
			const file = join(dir, "body.md");
			writeFileSync(file, "line one\nline two\n");
			const db = freshDbPath();
			const id = await addItem(db, ["x", "--body-file", file]);
			expect(await bodyOf(db, id)).toBe("line one\nline two\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("edit replaces the body with the file's text", async () => {
		const dir = scratch();
		try {
			const file = join(dir, "body.md");
			writeFileSync(file, "replaced text");
			const db = freshDbPath();
			const id = await addItem(db, ["x", "--body", "old text"]);
			const r = await runCli(db, ["edit", id, "--body-file", file]);
			expect(r.code).toBe(0);
			expect(await bodyOf(db, id)).toBe("replaced text");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("--body together with --body-file is refused, and nothing is created", async () => {
		const dir = scratch();
		try {
			const file = join(dir, "body.md");
			writeFileSync(file, "from file");
			const db = freshDbPath();
			const add = await runCli(db, ["add", "x", "--project", "omnislash", "--body", "a", "--body-file", file]);
			expect(add.code).not.toBe(0);
			expect(add.err).toContain("not both");
			const list = await runCli(db, ["list", "--json"]);
			expect(JSON.parse(list.out)).toEqual([]);

			const id = await addItem(db, ["keep", "--body", "original"]);
			const edit = await runCli(db, ["edit", id, "--body", "a", "--body-file", file]);
			expect(edit.code).not.toBe(0);
			expect(edit.err).toContain("not both");
			expect(await bodyOf(db, id)).toBe("original");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unreadable --body-file is refused naming the path, and nothing is created", async () => {
		const dir = scratch();
		try {
			const missing = join(dir, "does-not-exist.md");
			const db = freshDbPath();
			const r = await runCli(db, ["add", "x", "--project", "omnislash", "--body-file", missing]);
			expect(r.code).not.toBe(0);
			expect(r.err).toContain(missing);
			const list = await runCli(db, ["list", "--json"]);
			expect(JSON.parse(list.out)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a flag add does not take is refused by name, and nothing is created", async () => {
		const db = freshDbPath();
		const r = await runCli(db, ["add", "x", "--project", "omnislash", "--subject", "y"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob add does not take --subject");
		const list = await runCli(db, ["list", "--json"]);
		expect(JSON.parse(list.out)).toEqual([]);
	});

	test("a flag edit does not take is refused by name, and changes nothing", async () => {
		const db = freshDbPath();
		const id = await addItem(db, ["x", "--body", "keep me"]);
		const r = await runCli(db, ["edit", id, "--subject", "y"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob edit does not take --subject");
		expect(await bodyOf(db, id)).toBe("keep me");
	});

	test("--json and -q still work on add and edit", async () => {
		const db = freshDbPath();
		const id = await addItem(db, ["x", "--body", "b"]);
		const q = await runCli(db, ["edit", id, "--title", "y", "-q"]);
		expect(q.code).toBe(0);
		expect(q.out.trim()).toMatch(/^OB-\d+$/);
		const j = await runCli(db, ["edit", id, "--title", "z", "--json"]);
		expect(j.code).toBe(0);
		expect(JSON.parse(j.out).id).toBe(id);
	});
});

describe("modifier and type-gated flags are refused unless their parent is present (OB-2181 review)", () => {
	test("a detail flag on a task add is refused by name, and nothing is created", async () => {
		const db = freshDbPath();
		const r = await runCli(db, ["add", "x", "--project", "omnislash", "--choice", "c"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob add does not take --choice");
		expect(JSON.parse((await runCli(db, ["list", "--json"])).out)).toEqual([]);
	});

	test("--from without --triage is refused by name, and nothing is created", async () => {
		const db = freshDbPath();
		const r = await runCli(db, ["add", "x", "--project", "omnislash", "--from", "other"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob add does not take --from");
		expect(JSON.parse((await runCli(db, ["list", "--json"])).out)).toEqual([]);
	});

	test("--kind on an edit with no project is refused by name, and changes nothing", async () => {
		const db = freshDbPath();
		const id = await addItem(db, ["x", "--body", "keep"]);
		const r = await runCli(db, ["edit", id, "--kind", "home"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob edit does not take --kind");
		expect(await bodyOf(db, id)).toBe("keep");
	});
});

describe("per-type and per-parent gating, round 2 (OB-2181 review)", () => {
	test("a decision-only flag on a roadmap is refused by name, and nothing is created", async () => {
		const db = freshDbPath();
		const r = await runCli(db, ["add", "--type", "roadmap", "r", "--project", "omnislash", "--choice", "c"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob add does not take --choice");
		expect(JSON.parse((await runCli(db, ["list", "--json"])).out)).toEqual([]);
	});

	test("--link with --issue is refused by name before any GitHub call, and nothing is created", async () => {
		const db = freshDbPath();
		const r = await runCli(db, ["add", "x", "--project", "omnislash", "--issue", "--link", "https://github.com/a/b/issues/1"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("ob add does not take --link");
		expect(JSON.parse((await runCli(db, ["list", "--json"])).out)).toEqual([]);
	});
});


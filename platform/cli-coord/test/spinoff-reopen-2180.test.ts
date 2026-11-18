// OB-2180: `ob spinoff reopen <row> --note '<why>'` puts a row that was marked landed by mistake back to
// building. Refused for a row that is not landed, and for one whose work is on main (a landing commit naming
// its ticket since base_sha). A real git repo stands in for the checkout; the database is a temp file.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { spinoffReopen } from "../../../apps/cli/src/api/handlers.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { enqueueSpinoff } from "../src/commands/spinoff.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(repo: string, msg: string): string {
  writeFileSync(join(repo, "f.txt"), `${msg}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** A repo whose main is base plus one unrelated commit, a db with an item, and a row for it at `status`. */
async function setup(status: string) {
  const repo = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob2180-reopen-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  const base = commit(repo, "chore(config): before the dispatch");
  commit(repo, "docs(chart): something else");
  const dbPath = freshDbPath();
  const added = await runCli(dbPath, ["add", "reopen me", "--project", "omnislash", "--json"]);
  const itemId = String((JSON.parse(added.out) as { id: string | number }).id);
  const db = openDb(dbPath);
  const { row } = await enqueueSpinoff(db, { ticketRef: itemId, repo, branch: `b-${itemId}`, mode: "interactive", brief: "b" });
  db.query("UPDATE spinoff SET status = ?, base_sha = ?, agent_id = ? WHERE id = ?").run(status, base, `b-${itemId}`, row.id);
  const ticketRef = (db.query("SELECT ticket_ref FROM spinoff WHERE id = ?").get(row.id) as { ticket_ref: string }).ticket_ref;
  const statusOf = () => (db.query("SELECT status FROM spinoff WHERE id = ?").get(row.id) as { status: string }).status;
  return { repo, dbPath, db, itemId, ticketRef, branch: `b-${itemId}`, rowId: row.id, statusOf };
}

describe("ob spinoff reopen (OB-2180)", () => {
  test("a landed row with nothing on main goes back to building, the note on the ticket's trail", async () => {
    const t = await setup("merged");
    const r = await runCli(t.dbPath, ["spinoff", "reopen", String(t.rowId), "--note", "landed before its PR merged"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`is building again`);
    expect(t.statusOf()).toBe("launched");
    const trail = await decisionsForItem(t.db, t.itemId);
    expect(trail[0]).toMatchObject({ from: "landed", to: "building", note: "landed before its PR merged", spinoff_row: t.rowId });
  });

  test("refused, naming the sha, when a landing commit for the ticket is on main since base", async () => {
    const t = await setup("merged");
    const sha = commit(t.repo, `feat(${t.ticketRef}): the real land`);
    const r = await runCli(t.dbPath, ["spinoff", "reopen", String(t.rowId), "--note", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`merged as ${sha.slice(0, 8)} on main`);
    expect(t.statusOf()).toBe("merged");
  });

  test("refused while the ticket is done: reconcile would land it straight back", async () => {
    const t = await setup("merged");
    t.db.query("UPDATE item SET status = 'done' WHERE id = ?").run(t.itemId);
    const r = await runCli(t.dbPath, ["spinoff", "reopen", String(t.rowId), "--note", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`${t.ticketRef} is done`);
    expect(r.err).toContain(`ob reopen ${t.ticketRef}`);
    expect(t.statusOf()).toBe("merged");
  });

  test("refused when its branch merged into main with a commit of its own (no ref in the subject)", async () => {
    const t = await setup("merged");
    git(t.repo, "checkout", "-q", "-b", t.branch);
    commit(t.repo, "fix the header");
    git(t.repo, "checkout", "-q", "main");
    git(t.repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #9 from x/y", t.branch);
    const r = await runCli(t.dbPath, ["spinoff", "reopen", String(t.rowId), "--note", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`its branch ${t.branch} is merged into main with commits of its own`);
    expect(t.statusOf()).toBe("merged");
  });

  test("refused when the branch is merged and the row has no base_sha and the branch no reflog", async () => {
    const t = await setup("merged");
    t.db.query("UPDATE spinoff SET base_sha = NULL WHERE id = ?").run(t.rowId);
    git(t.repo, "branch", t.branch, "main");
    git(t.repo, "reflog", "expire", "--expire=now", `refs/heads/${t.branch}`);
    const r = await runCli(t.dbPath, ["spinoff", "reopen", String(t.rowId), "--note", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("records no base_sha");
    expect(t.statusOf()).toBe("merged");
  });

  test("refused for a row that is not landed", async () => {
    const t = await setup("launched");
    const r = await runCli(t.dbPath, ["spinoff", "reopen", String(t.rowId), "--note", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not landed: only a landed row can be reopened");
    expect(t.statusOf()).toBe("launched");
  });

  test("refused without a note", async () => {
    const t = await setup("merged");
    const r = await runCli(t.dbPath, ["spinoff", "reopen", String(t.rowId)]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("needs --note");
    expect(t.statusOf()).toBe("merged");
  });

  test("the API host's half moves only a landed row, and wants a note", async () => {
    const t = await setup("merged");
    const s = asStore(t.db);
    await expect(spinoffReopen(s, { id: t.rowId, note: " " })).rejects.toThrow("needs a note");
    const res = await spinoffReopen(s, { id: t.rowId, note: "wrong land" });
    expect(res.row.status).toBe("launched");
    await expect(spinoffReopen(s, { id: t.rowId, note: "again" })).rejects.toThrow("not landed (nothing to reopen)");
  });

  test("an API client checks git here, reads a ticket the host does not know as not done, and asks the host to move the row", async () => {
    const t = await setup("merged");
    const stored = t.db.query("SELECT * FROM spinoff WHERE id = ?").get(t.rowId) as Record<string, unknown>;
    const external = { ...stored, ticket_ref: "HC-9", item_id: null }; // a ticket with no item on the host
    const BASE = "https://ob.example.test";
    const sent: Array<{ key: string; body: Record<string, unknown> }> = [];
    const transport: ApiTransport = async (req: ApiRequest) => {
      const key = `${req.method} ${req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]}`;
      const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
      sent.push({ key, body });
      if (key === "GET /spinoffs") return { status: 200, body: JSON.stringify({ spinoffs: [external] }) };
      if (key === "GET /spinoffs/config") return { status: 200, body: JSON.stringify({ config: { repo_checkouts: {}, launcher: "t3", launcher_by_repo: {}, engine: "claude" } }) };
      if (key === "POST /spinoffs/reopen") return { status: 200, body: JSON.stringify({ row: { ...external, status: "launched" } }) };
      return { status: 404, body: JSON.stringify({ error: { code: "not_found", message: `no stub for ${key}` } }) };
    };
    const r = await runCli(freshDbPath(), ["spinoff", "reopen", String(t.rowId), "--note", "wrong land"], { api: { base: BASE, token: "t", transport } });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("HC-9 (row");
    expect(sent.find((c) => c.key === "POST /spinoffs/reopen")?.body).toEqual({ id: t.rowId, note: "wrong land" });
  });
});

// OS-134: a project's lifecycle status (active|paused|archived). `ob project pause|resume|archive`, `project list`
// hiding archived unless --all, `ob next` leaving held projects out, and `ob spinoff` / `spinoff queue` / the drain /
// the API enqueue refusing a held project's ticket unless `--allow-paused '<why>'`, whose reason goes on the trail.
// In-process against fresh SQLite databases, a fake T3 and a faked shell: no network, no live store.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRepoDir, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem, setStatus } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { enqueue as apiEnqueue, spinoffLaunchable } from "../../../apps/cli/src/api/handlers.ts";
import { getProject, updateProject } from "../../../apps/cli/src/project.ts";
import { parseProjectStatus, projectStatusOf } from "../../../apps/cli/src/project-status.ts";
import { __setSh, drainSpinoffs, enqueueSpinoff, launchQueuedRow, listSpinoffs, localSpinoffSteps } from "../src/commands/spinoff.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** A fresh store with project `pp` and one ticket in it; returns the db path and the item id. */
async function setup(): Promise<{ dbPath: string; id: string }> {
  const dbPath = freshDbPath();
  expect((await runCli(dbPath, ["project", "add", "pp", "--kind", "side"])).code).toBe(0);
  const db = openDb(dbPath);
  try {
    const id = await createItem(db, { type: "task", title: "paused work", projectId: "pp", body: "## Drilled\n- read\n\n## Done when\n- a test" });
    return { dbPath, id };
  } finally {
    db.close();
  }
}

async function dispatch(dbPath: string, repo: string, id: string, ...extra: string[]) {
  cleanup.push(__setSh(() => ({ ok: true, err: "", out: "" })));
  const t3 = installFakeT3([repo]);
  const wt = mkdtempSync(join(tmpdir(), "ob-134-"));
  try {
    const r = await runCli(dbPath, ["spinoff", ...extra.slice(0, extra[0] === "queue" ? 1 : 0), id, "--repo", repo, "--branch", `build-${id}`, "--worktree", wt, "--brief", "b", "--no-check", "test", ...extra.filter((x) => x !== "queue")]);
    return { ...r, launches: t3.launches };
  } finally {
    t3.restore();
    rmSync(wt, { recursive: true, force: true });
  }
}

const rowCount = async (dbPath: string): Promise<number> => JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out).length;

describe("project status (OS-134)", () => {
  test("parse is case-folded; an unknown stored value reads active", () => {
    expect(parseProjectStatus(" Paused ")).toBe("paused");
    expect(projectStatusOf({ status: "frozen" })).toBe("active");
    expect(projectStatusOf(null)).toBe("active");
  });

  test("migration 0005: a project written before it reads active after it", () => {
    const dir = join(import.meta.dir, "../../../apps/cli/src/db/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const run = (db: Database, f: string) => {
      for (const stmt of readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) db.exec(stmt);
    };
    const db = new Database(":memory:");
    try {
      for (const f of files.filter((f) => f < "0005")) run(db, f);
      db.query("INSERT INTO project(id,name,kind,created_at) VALUES('old','old','side','2026-01-01')").run();
      run(db, "0005_project_status.sql");
      expect(db.query("SELECT status FROM project WHERE id='old'").get()).toEqual({ status: "active" });
    } finally {
      db.close();
    }
  });

  test("a new project reads active; pause, archive and resume set it; edit --status sets it; a bad one is a usage error", async () => {
    const { dbPath } = await setup();
    const status = async () => {
      const db = openDb(dbPath);
      try {
        return (await getProject(db, "pp"))!.status;
      } finally {
        db.close();
      }
    };
    expect(await status()).toBe("active");
    expect((await runCli(dbPath, ["project", "pause", "pp"])).code).toBe(0);
    expect(await status()).toBe("paused");
    expect((await runCli(dbPath, ["project", "archive", "pp"])).code).toBe(0);
    expect(await status()).toBe("archived");
    expect((await runCli(dbPath, ["project", "resume", "pp"])).code).toBe(0);
    expect(await status()).toBe("active");
    expect((await runCli(dbPath, ["project", "edit", "pp", "--status", "paused"])).code).toBe(0);
    expect(await status()).toBe("paused");
    const bad = await runCli(dbPath, ["project", "edit", "pp", "--status", "frozen"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--status must be one of active, paused, archived");
    const unknown = await runCli(dbPath, ["project", "pause", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no project 'nope'");
  });

  test("list: archived is hidden unless --all; paused shows its status; --json carries status on every row", async () => {
    const { dbPath } = await setup();
    expect((await runCli(dbPath, ["project", "add", "arch", "--kind", "side"])).code).toBe(0);
    expect((await runCli(dbPath, ["project", "add", "live", "--kind", "side"])).code).toBe(0);
    expect((await runCli(dbPath, ["project", "archive", "arch"])).code).toBe(0);
    expect((await runCli(dbPath, ["project", "pause", "pp"])).code).toBe(0);

    const plain = (await runCli(dbPath, ["project", "list"])).out;
    expect(plain).not.toContain("arch");
    expect(plain.split("\n").find((l) => l.startsWith("pp\t"))!.split("\t")[8]).toBe("paused");
    expect(plain.split("\n").find((l) => l.startsWith("live\t"))!.split("\t")[8]).toBe("active");

    const all = (await runCli(dbPath, ["project", "list", "--all"])).out;
    expect(all.split("\n").find((l) => l.startsWith("arch\t"))!.split("\t")[8]).toBe("archived");

    const json = JSON.parse((await runCli(dbPath, ["project", "list", "--json", "--all"])).out) as Array<{ id: string; status: string }>;
    expect(Object.fromEntries(json.map((p) => [p.id, p.status]))).toEqual({ arch: "archived", live: "active", pp: "paused" });
    const visible = JSON.parse((await runCli(dbPath, ["project", "list", "--json"])).out) as Array<{ id: string; status: string }>;
    expect(visible.map((p) => p.id).sort()).toEqual(["live", "pp"]);
    expect(visible.every((p) => typeof p.status === "string")).toBe(true);
  });

  test("ob next leaves a paused project's ticket out, and --project still shows it", async () => {
    const { dbPath, id } = await setup();
    const ids = async (...extra: string[]) => (JSON.parse((await runCli(dbPath, ["next", "--json", ...extra])).out) as Array<{ id: string }>).map((i) => i.id);
    expect(await ids()).toContain(id);
    expect((await runCli(dbPath, ["project", "pause", "pp"])).code).toBe(0);
    expect(await ids()).not.toContain(id);
    expect(await ids("--project", "pp")).toContain(id);
  });

  test("ob spinoff refuses a paused project's ticket naming the status, and leaves no row", async () => {
    const { dbPath, id } = await setup();
    const repo = fakeRepoDir();
    expect((await runCli(dbPath, ["project", "pause", "pp"])).code).toBe(0);
    const r = await dispatch(dbPath, repo, id);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is in project pp is paused");
    expect(r.err).toContain("Nothing was queued");
    expect(r.launches).toHaveLength(0);
    expect(await rowCount(dbPath)).toBe(0);

    const q = await dispatch(dbPath, repo, id, "queue");
    expect(q.code).toBe(1);
    expect(q.err).toContain("project pp is paused");
    expect(await rowCount(dbPath)).toBe(0);

    expect((await runCli(dbPath, ["project", "archive", "pp"])).code).toBe(0);
    expect((await dispatch(dbPath, repo, id)).err).toContain("project pp is archived");
  });

  test("--allow-paused dispatches and puts the reason on the trail, bound to the row; a blank one is refused", async () => {
    const { dbPath, id } = await setup();
    const repo = fakeRepoDir();
    expect((await runCli(dbPath, ["project", "pause", "pp"])).code).toBe(0);
    const blank = await dispatch(dbPath, repo, id, "--allow-paused", "  ");
    expect(blank.code).toBe(2);
    expect(blank.err).toContain("--allow-paused needs a reason");

    const r = await dispatch(dbPath, repo, id, "--allow-paused", "a hotfix the owner asked for");
    expect(r.code).toBe(0);
    expect(r.launches).toHaveLength(1);
    const db = openDb(dbPath);
    try {
      const override = (await decisionsForItem(db, id)).find((d) => d.to === "allow-paused");
      expect(override?.from).toBe("paused");
      expect(override?.note).toBe("a hotfix the owner asked for");
      expect(override?.spinoff_row).toBe((await listSpinoffs(db))[0]!.id);
    } finally {
      db.close();
    }
  });

  test("the drain leaves a held project's queued row pending as not ready, and launches it once resumed", async () => {
    const { dbPath, id } = await setup();
    const repo = fakeRepoDir();
    const db = openDb(dbPath);
    try {
      const store = asStore(db);
      const { row } = await enqueueSpinoff(store, { ticketRef: id, repo, branch: `build-${id}`, mode: "interactive", brief: "b" });
      await updateProject(store, "pp", { status: "paused" });
      const drained = await drainSpinoffs(store);
      expect(drained.launched).toEqual([]);
      expect(drained.not_ready).toEqual([{ ticket: row.ticket_ref, reason: expect.stringContaining("project pp is paused") }]);
      expect((await listSpinoffs(store, "pending")).map((r) => r.id)).toEqual([row.id]);
      // A dispatch carrying --allow-paused itself skips the trail read (a split client's replica may lag the
      // server's write): the paused check passes, so the next gate (a done ticket) is what stops it here.
      await setStatus(store, id, "open", "done");
      const released = await launchQueuedRow(store, row, "", localSpinoffSteps(store), () => [], true);
      expect(released.kind === "not-ready" && released.reason).not.toContain("paused");
      await setStatus(store, id, "done", "open");

      const launchable = await spinoffLaunchable(store, {});
      expect(launchable.rows[0]!.paused).toContain("project pp is paused");
      await updateProject(store, "pp", { status: "active" });
      expect((await spinoffLaunchable(store, {})).rows[0]!.paused).toBeNull();
    } finally {
      db.close();
    }
  });

  test("the API enqueue refuses a paused project's ticket, and records --allow-paused", async () => {
    const { dbPath, id } = await setup();
    const db = openDb(dbPath);
    try {
      const store = asStore(db);
      await updateProject(store, "pp", { status: "paused" });
      const req = { ticket_ref: id, repo: "pp", branch: `build-${id}`, mode: "interactive" as const, brief: "b", no_check: "test" };
      await expect(apiEnqueue(store, req)).rejects.toThrow("project pp is paused");
      expect(await listSpinoffs(store)).toEqual([]);
      const ok = await apiEnqueue(store, { ...req, allow_paused: "owner said go" });
      const override = (await decisionsForItem(store, id)).find((d) => d.to === "allow-paused");
      expect(override?.spinoff_row).toBe(ok.row.id);
      expect((await spinoffLaunchable(store, {})).rows[0]!.paused).toBeNull();
    } finally {
      db.close();
    }
  });
});

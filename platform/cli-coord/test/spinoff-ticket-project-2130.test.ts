// OB-2130: with no --repo, `ob spinoff <ref>` builds in the ticket's own project checkout, whatever the cwd.
// Seen on SS-3 to SS-11: a slashslash ticket dispatched from the omnislash checkout got an omnislash row, an
// `ss-5` branch and an empty omnislash.ss-5 worktree. Every path is covered here on fakes: the local enqueue
// (the store in hand), the split client's argv rewrite, and the API client (a stubbed transport). No network,
// no live DB, no real T3, no real git.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { setProjectKey } from "../../../apps/cli/src/refs.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import type { Ctx } from "../../../apps/cli/src/ctx.ts";
import { __setSh, cmdSpinoff, listSpinoffs, rewriteSpinoffRepoArgv, spinoffEnqueueRef, ticketProjectRepoFor, ticketProjectRepoWith } from "../src/commands/spinoff.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** A fake git checkout `<tmp>/<name>`, realpath'd so a comparison never trips on a /tmp symlink. */
function checkout(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ob-2130-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** Run the CLI with the process sitting in `cwd`, restoring it after. */
async function inDir(cwd: string, dbPath: string, args: string[], deps: Parameters<typeof runCli>[2] = {}) {
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    return await runCli(dbPath, args, deps);
  } finally {
    process.chdir(prev);
  }
}

/** No branch is taken (rev-parse / ls-remote fail); `worktree add` makes its directory; the rest quietly succeed. */
function stubGit(): void {
  cleanup.push(
    __setSh((cmd: string[]) => {
      if (cmd.includes("rev-parse") || cmd.includes("ls-remote")) return { ok: false, out: "", err: "" };
      const add = cmd.indexOf("add");
      if (cmd.includes("worktree") && add > 0) {
        const path = cmd[add + 1]!;
        mkdirSync(path, { recursive: true });
        cleanup.push(() => rmSync(path, { recursive: true, force: true }));
      }
      return { ok: true, out: "", err: "" };
    }),
  );
}

interface World {
  dbPath: string;
  omnislash: string;
  slashslash: string;
  ssRef: string;
  obRef: string;
  personalRef: string;
}

/** A tracker with a slashslash ticket, an omnislash ticket and a personal one; slashslash's checkout is mapped. */
async function world(): Promise<World> {
  const omnislash = checkout("omnislash");
  const slashslash = checkout("slashslash");
  const dbPath = freshDbPath();
  const db = openDb(dbPath, { create: true });
  await registerProject(db, { name: "slashslash", kind: "side" });
  await setProjectKey(db, "slashslash", "SS");
  await registerProject(db, { name: "omnislash", kind: "side" });
  await setProjectKey(db, "omnislash", "OB").catch(() => {});
  await registerProject(db, { name: "personal", kind: "home" });
  await setConfig(db, "repo_checkouts", JSON.stringify({ slashslash, omnislash }));
  const ss = await createItem(db, { type: "task", title: "Ship the pricing page", projectId: "slashslash" });
  const ob = await createItem(db, { type: "task", title: "An omnislash change", projectId: "omnislash" });
  const personal = await createItem(db, { type: "task", title: "A personal errand", projectId: "personal" });
  const refOf = (id: string) => (db.query("SELECT ref FROM item WHERE id = ?").get(id) as { ref: string | null }).ref ?? id;
  const w = { dbPath, omnislash, slashslash, ssRef: refOf(ss), obRef: refOf(ob), personalRef: refOf(personal) };
  db.close();
  return w;
}

const NO_CHECK = ["--no-check", "a test fixture"];

describe("the local enqueue builds in the ticket's project (OB-2130)", () => {
  test("a slashslash ticket from the omnislash cwd: slashslash row, title-slug branch, slashslash worktree, no omnislash.<ref>", async () => {
    const w = await world();
    expect(w.ssRef).toBe("SS-1");
    stubGit();
    const t3 = installFakeT3([w.slashslash]);
    cleanup.push(t3.restore);
    const r = await inDir(w.omnislash, w.dbPath, ["spinoff", w.ssRef, ...NO_CHECK]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`SS-1 is a slashslash ticket: building in ${w.slashslash}`);
    const [row] = await listSpinoffs(openDb(w.dbPath));
    expect(row!.repo).toBe(w.slashslash);
    expect(row!.branch).toBe("ship-the-pricing-page");
    expect(row!.worktree).toBe(`${w.slashslash}.ss-1`);
    expect(t3.launches).toHaveLength(1);
    expect(existsSync(`${w.omnislash}.ss-1`)).toBe(false);
    expect(existsSync(`${w.omnislash}.ship-the-pricing-page`)).toBe(false);

    // ... and the clean-repo builder can record its verdict on that row (no "is an omnislash build" refusal).
    const state = await inDir(w.omnislash, w.dbPath, ["spinoff", "state", w.ssRef, "landable", "--gate", "green"]);
    expect(state.err).not.toContain("is an omnislash build");
    expect(state.code).toBe(0);
    expect((await listSpinoffs(openDb(w.dbPath)))[0]!.verdict).toBe("landable");
  });

  test("a project checkout with no T3 project is refused at enqueue: no row, no worktree", async () => {
    const w = await world();
    stubGit();
    const t3 = installFakeT3([w.omnislash]); // T3 knows omnislash, not slashslash
    cleanup.push(t3.restore);
    const r = await inDir(w.omnislash, w.dbPath, ["spinoff", w.ssRef, ...NO_CHECK]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`no T3 project is registered for ${w.slashslash}`);
    expect(await listSpinoffs(openDb(w.dbPath))).toEqual([]);
    expect(t3.launches).toHaveLength(0);
    expect(existsSync(`${w.slashslash}.ss-1`)).toBe(false);
    expect(existsSync(`${w.omnislash}.ss-1`)).toBe(false);
  });

  test("a dispatch from the project's own checkout is refused the same way when T3 has no project for it", async () => {
    const w = await world();
    stubGit();
    const t3 = installFakeT3([w.omnislash]);
    cleanup.push(t3.restore);
    const r = await inDir(w.slashslash, w.dbPath, ["spinoff", w.ssRef, ...NO_CHECK]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`no T3 project is registered for ${w.slashslash}`);
    expect(await listSpinoffs(openDb(w.dbPath))).toEqual([]);
  });

  test("an OB ticket from the omnislash cwd gets the row it always did", async () => {
    const w = await world();
    stubGit();
    const t3 = installFakeT3([w.omnislash]);
    cleanup.push(t3.restore);
    const r = await inDir(w.omnislash, w.dbPath, ["spinoff", w.obRef, ...NO_CHECK]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("is a omnislash ticket");
    const [row] = await listSpinoffs(openDb(w.dbPath));
    expect(row!.repo).toBe(w.omnislash);
    expect(row!.branch).toBe(w.obRef.toLowerCase());
    expect(row!.worktree).toBe(`${w.omnislash}.${w.obRef.toLowerCase()}`);
  });

  test("a project with no checkout here (personal) keeps the cwd; --repo still overrides the ticket's project", async () => {
    const w = await world();
    stubGit();
    const other = checkout("widgets");
    const t3 = installFakeT3([w.omnislash, other]);
    cleanup.push(t3.restore);
    const personal = await inDir(w.omnislash, w.dbPath, ["spinoff", w.personalRef, ...NO_CHECK]);
    expect(personal.code).toBe(0);
    expect((await listSpinoffs(openDb(w.dbPath))).find((r) => r.ticket_ref === w.personalRef)!.repo).toBe(w.omnislash);

    const overridden = await inDir(w.omnislash, w.dbPath, ["spinoff", w.ssRef, "--repo", other, ...NO_CHECK]);
    expect(overridden.code).toBe(0);
    expect(overridden.err).not.toContain("is a slashslash ticket");
    expect((await listSpinoffs(openDb(w.dbPath))).find((r) => r.ticket_ref === w.ssRef)!.repo).toBe(other);
  });

  test("`ob spinoff brief` from the omnislash cwd reads a slashslash ticket against slashslash", async () => {
    const w = await world();
    stubGit();
    const r = await inDir(w.omnislash, w.dbPath, ["spinoff", "brief", w.ssRef, "--json"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("is a slashslash ticket");
    const out = JSON.parse(r.out) as { ticket: string; branch: string; brief: string };
    expect(out.branch).toBe("ship-the-pricing-page"); // slashslash's clean-repo branch, not omnislash's `ss-1`
    expect(out.brief.split("\n\n")[0]).toBe("SS-1 · Ship the pricing page");
  });
});

describe("the resolution helpers (OB-2130)", () => {
  test("ticketProjectRepoWith: a checkout that is not the cwd's repo; null for none, an unknown project, or the cwd's own repo", () => {
    const ss = checkout("slashslash");
    const ob = checkout("omnislash");
    const map = { slashslash: ss, omnislash: ob };
    expect(ticketProjectRepoWith(map, "SS-5", "slashslash", ob)?.repo).toBe(ss);
    expect(ticketProjectRepoWith(map, "SS-5", "slashslash", ob)?.notice).toBe(`SS-5 is a slashslash ticket: building in ${ss}`);
    expect(ticketProjectRepoWith(map, "OB-1", "omnislash", ob)).toBeNull();
    // a worktree of the project's checkout counts as that repo
    const wt = `${ob}.ob-1`;
    mkdirSync(join(wt, ".git"), { recursive: true });
    expect(ticketProjectRepoWith(map, "OB-1", "omnislash", wt)).toBeNull();
    expect(ticketProjectRepoWith(map, "X-1", "no-such-project-2130", ob)).toBeNull();
    expect(ticketProjectRepoWith(map, "X-1", null, ob)).toBeNull();
  });

  test("the split client (`ob spinoff <ref>` with a server) sends `spinoff queue <ref> --repo slashslash`", async () => {
    const w = await world();
    const t3 = installFakeT3([w.slashslash]);
    cleanup.push(t3.restore);
    const db = openDb(w.dbPath);
    const sent: string[][] = [];
    const ctx = {
      db,
      store: sqliteStoreFor(db),
      dbPath: w.dbPath,
      mode: "human",
      flags: { "no-check": "a test fixture" },
      args: [w.ssRef],
      // the server's answer is beside the point: the argv it was sent is what this proves
      remote: { write: (argv: string[]) => (sent.push(argv), { ok: false, message: "test server stops here" }) },
    } as unknown as Ctx;
    const prev = process.cwd();
    process.chdir(w.omnislash);
    try {
      await expect(cmdSpinoff(ctx)).rejects.toThrow("test server stops here");
    } finally {
      process.chdir(prev);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.slice(0, 3)).toEqual(["spinoff", "queue", w.ssRef]);
    expect(sent[0]!.join(" ")).toContain("--repo slashslash");
    db.close();
  });

  test("the split client's argv rewrite sends --repo slashslash for a slashslash ticket from the omnislash cwd", async () => {
    const w = await world();
    const db = openDb(w.dbPath);
    expect(spinoffEnqueueRef("spinoff", [w.ssRef])).toBe(w.ssRef);
    expect(spinoffEnqueueRef("spinoff", ["queue", w.ssRef])).toBe(w.ssRef);
    expect(spinoffEnqueueRef("spinoff", ["list"])).toBeNull();
    const fromProject = await ticketProjectRepoFor(db, w.ssRef, w.omnislash);
    expect(fromProject?.repo).toBe(w.slashslash);
    const argv = ["spinoff", "queue", w.ssRef];
    const rewritten = rewriteSpinoffRepoArgv({ argv, command: "spinoff", args: ["queue", w.ssRef], flags: {}, db, cwd: w.omnislash, ticketRepo: fromProject?.repo });
    expect(rewritten.error).toBeNull();
    expect(rewritten.argv).toEqual([...argv, "--repo", "slashslash"]);
    // an OB ticket from the omnislash cwd: nothing from the project, so the cwd's slug as before
    expect(await ticketProjectRepoFor(db, w.obRef, w.omnislash)).toBeNull();
    const asBefore = rewriteSpinoffRepoArgv({ argv: ["spinoff", w.obRef], command: "spinoff", args: [w.obRef], flags: {}, db, cwd: w.omnislash });
    expect(asBefore.argv).toEqual(["spinoff", w.obRef, "--repo", "omnislash"]);
    db.close();
  });
});

// --- the API client, the path this desktop takes ------------------------------------------------------------

const BASE = "https://ob.example.test";

function stub(answers: Record<string, unknown>) {
  const calls: ApiRequest[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const transport: ApiTransport = async (req) => {
    calls.push(req);
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    bodies.push(body);
    const key = `${req.method} ${req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!}`;
    if (!(key in answers)) return { status: 404, body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }) };
    const a = answers[key];
    if (a && typeof a === "object" && "__status" in a) return { status: (a as { __status: number }).__status, body: JSON.stringify({ error: { code: "boom", message: "the host fell over" } }) };
    return { status: 200, body: JSON.stringify(typeof a === "function" ? (a as (b: Record<string, unknown>) => unknown)(body) : a) };
  };
  return { calls, bodies, deps: { api: { base: BASE, token: "test-token", transport } } };
}

function apiConfig(checkouts: Record<string, string>) {
  return { config: { repo_checkouts: checkouts, launcher: "t3", launcher_by_repo: {}, engine: "claude" } };
}

const queuedRow = (body: Record<string, unknown>) => ({
  row: { id: 21, ticket_ref: String(body.ticket_ref), repo: String(body.repo), branch: String(body.branch), worktree: "/x", mode: "interactive", brief: "b", status: "pending", error: null, agent_id: null, request_at: "2026-11-14T00:00:00.000Z" },
  deduped: false,
});

describe("the API client sends the ticket's project as --repo (OB-2130)", () => {
  test("a slashslash item from the omnislash cwd posts repo slashslash; an omnislash one posts omnislash", async () => {
    const omnislash = checkout("omnislash");
    const slashslash = checkout("slashslash");
    stubGit();
    const s = stub({
      "GET /spinoffs/config": apiConfig({ omnislash, slashslash }),
      "GET /spinoffs": { spinoffs: [] },
      "GET /items/SS-5": { item: { id: "2501", ref: "SS-5", title: "Ship the pricing page", body: null, project: "slashslash", tags: [] } },
      "GET /items/OB-9": { item: { id: "2502", ref: "OB-9", title: "An omnislash change", body: null, project: "omnislash", tags: [] } },
      "POST /spinoffs": queuedRow,
    });
    const r = await inDir(omnislash, freshDbPath(), ["spinoff", "queue", "SS-5"], s.deps);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`SS-5 is a slashslash ticket: building in ${slashslash}`);
    const posted = s.bodies[s.calls.findIndex((c) => c.method === "POST")]!;
    expect(posted.repo).toBe("slashslash");
    expect(posted.branch).toBe("ship-the-pricing-page");

    const ob = await inDir(omnislash, freshDbPath(), ["spinoff", "queue", "OB-9"], s.deps);
    expect(ob.code).toBe(0);
    const posts = s.calls.map((c, i) => [c, s.bodies[i]!] as const).filter(([c]) => c.method === "POST");
    expect(posts.at(-1)![1].repo).toBe("omnislash");
    expect(posts.at(-1)![1].branch).toBe("ob-9");
  });

  test("a failed item read (not a 404) is said on stderr and the cwd is used", async () => {
    const omnislash = checkout("omnislash");
    stubGit();
    const s = stub({
      "GET /spinoffs/config": apiConfig({ omnislash }),
      "GET /items/SS-5": { __status: 500 },
      "POST /spinoffs": queuedRow,
    });
    const r = await inDir(omnislash, freshDbPath(), ["spinoff", "queue", "SS-5"], s.deps);
    expect(r.err).toContain("could not read SS-5's project");
    const posted = s.bodies[s.calls.findIndex((c) => c.method === "POST")]!;
    expect(posted.repo).toBe("omnislash");
  });

  test("a launch over the API to a project checkout T3 does not know is refused before the POST", async () => {
    const omnislash = checkout("omnislash");
    const slashslash = checkout("slashslash");
    stubGit();
    const t3 = installFakeT3([omnislash]);
    cleanup.push(t3.restore);
    const s = stub({
      "GET /spinoffs/config": apiConfig({ omnislash, slashslash }),
      "GET /items/SS-5": { item: { id: "2501", ref: "SS-5", title: "Ship the pricing page", body: null, project: "slashslash", tags: [] } },
      "POST /spinoffs": queuedRow,
    });
    const r = await inDir(omnislash, freshDbPath(), ["spinoff", "SS-5"], s.deps);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`no T3 project is registered for ${slashslash}`);
    expect(s.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

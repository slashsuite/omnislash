// OB-2255: `ob t3 team …` and `ob t3 architect|sentinel|muse …`, on a fake T3 seam that records every pin, unpin,
// rename and auto-settle call. The local half runs against a throwaway SQLite store through `runCli`; the API half
// sends the CLI's own requests through `createObApi` on a real Postgres store (the ob 325 harness: a local
// cluster, no network, no live database), so the contract, the route, the handler and the client are one path.
import { afterEach, describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3, type FakeT3Install } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { teamSeedMessage, worktreeRepoOf } from "../../../apps/cli/src/t3/dispatch.ts";
import type { T3Thread } from "../../../apps/cli/src/t3/client.ts";
import { isTeamRoleAgent, teamHandoffTarget, teamRoleAgentId, teamThreadTitle } from "../../../apps/cli/src/team.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";

/** The checkout `ob t3 architect` resolves the cwd to (a worktree is its repo), and so the project a team of one takes. */
const REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());
const REPO_SLUG = basename(REPO);

let fake: FakeT3Install | null = null;
afterEach(() => {
  fake?.restore();
  fake = null;
});

/** A live thread T3 knows, for `--thread` to adopt. */
function liveThread(id: string, over: Partial<T3Thread> = {}): T3Thread {
  return {
    threadId: id,
    projectId: "proj-0",
    title: "New thread",
    status: "idle",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "claude-opus-5-5",
    providerInstanceId: "claudeAgent",
    activeRunId: null,
    latestRunId: null,
    ...over,
  };
}

function t3(...live: string[]): FakeT3Install {
  fake = installFakeT3([REPO]);
  for (const id of live) fake.threads.push(liveThread(id));
  return fake;
}

/** Every seam call a refused command must not make. */
function seamCalls(f: FakeT3Install): number {
  return f.launches.length + f.pinned.length + f.unpinned.length + f.renamed.length + f.autoSettleOff.length;
}

async function seeded(): Promise<string> {
  const dbPath = freshDbPath();
  openDb(dbPath, { create: true }).close();
  for (const p of ["pixelslash", "flakeslash", "acme"]) {
    expect((await runCli(dbPath, ["project", "add", p, "--kind", "side"])).code).toBe(0);
  }
  return dbPath;
}

describe("ob t3 team, local (OB-2255 Done when 2)", () => {
  test("add with --projects, show and list name the members and each role's thread or the command that adds it", async () => {
    const dbPath = await seeded();
    expect((await runCli(dbPath, ["t3", "team", "add", "slash", "--icon", "⚔️", "--display-name", "Slash", "--projects", "pixelslash,flakeslash"])).code).toBe(0);
    const show = await runCli(dbPath, ["t3", "team", "show", "slash"]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("team:      ⚔️ Slash (slash)");
    expect(show.out).toContain("members:   flakeslash, pixelslash");
    expect(show.out).toContain("architect: none, add with `ob t3 architect slash`");
    expect(show.out).toContain("sentinel:  none, add with `ob t3 sentinel slash`");
    expect(JSON.parse((await runCli(dbPath, ["t3", "team", "show", "slash", "--json"])).out)).toMatchObject({
      name: "slash",
      icon: "⚔️",
      display_name: "Slash",
      members: ["flakeslash", "pixelslash"],
      threads: [],
    });
    expect((await runCli(dbPath, ["t3", "team", "list"])).out.trim()).toBe("slash\t⚔️\tSlash\tflakeslash,pixelslash\t-");
    expect((await runCli(dbPath, ["t3", "team", "edit", "slash", "--display-name", "Slashers"])).code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["t3", "team", "show", "slash", "--json"])).out).display_name).toBe("Slashers");
  });

  test("join and leave move projects; an unknown team exits 1; a project in two teams is refused", async () => {
    const dbPath = await seeded();
    await runCli(dbPath, ["t3", "team", "add", "slash"]);
    await runCli(dbPath, ["t3", "team", "add", "omni"]);
    expect((await runCli(dbPath, ["t3", "team", "join", "slash", "pixelslash", "flakeslash"])).code).toBe(0);

    const unknown = await runCli(dbPath, ["t3", "team", "join", "nope", "acme"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no team 'nope'");
    expect((await runCli(dbPath, ["t3", "team", "show", "nope"])).code).toBe(1);

    const twice = await runCli(dbPath, ["t3", "team", "join", "omni", "pixelslash"]);
    expect(twice.code).toBe(1);
    expect(twice.err).toContain("project 'pixelslash' is already in team 'slash'");
    // Refused before any write: acme, named first, did not join either.
    expect((await runCli(dbPath, ["t3", "team", "join", "omni", "acme", "pixelslash"])).code).toBe(1);
    expect(JSON.parse((await runCli(dbPath, ["t3", "team", "show", "omni", "--json"])).out).members).toEqual([]);
    const addTwice = await runCli(dbPath, ["t3", "team", "add", "other", "--projects", "pixelslash"]);
    expect(addTwice.code).toBe(1);

    const left = await runCli(dbPath, ["t3", "team", "leave", "pixelslash"]);
    expect(left.code).toBe(0);
    expect(left.out).toContain("pixelslash: left team slash");
    expect((await runCli(dbPath, ["t3", "team", "join", "omni", "pixelslash"])).code).toBe(0);
    const projects = JSON.parse((await runCli(dbPath, ["project", "list", "--json"])).out) as Array<{ id: string; team_name: string | null }>;
    expect(projects.find((p) => p.id === "pixelslash")!.team_name).toBe("omni");
    expect(projects.find((p) => p.id === "flakeslash")!.team_name).toBe("slash");
  });

  test("rm is refused while the team has members or roles, and --force clears both and unpins", async () => {
    const dbPath = await seeded();
    await runCli(dbPath, ["t3", "team", "add", "slash", "--projects", "pixelslash"]);
    const f = t3("thr-a", "thr-s");
    expect((await runCli(dbPath, ["t3", "architect", "slash", "--thread", "thr-a"])).code).toBe(0);
    expect((await runCli(dbPath, ["t3", "sentinel", "slash", "--thread", "thr-s"])).code).toBe(0);
    const refused = await runCli(dbPath, ["t3", "team", "rm", "slash"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("members pixelslash and threads architect-slash, sentinel-slash");
    expect(f.unpinned).toEqual([]);
    expect((await runCli(dbPath, ["t3", "team", "rm", "slash", "--force"])).code).toBe(0);
    expect(f.unpinned).toEqual(["thr-a", "thr-s"]);
    const db = openDb(dbPath);
    expect(db.query("SELECT group_name FROM project WHERE id = 'pixelslash'").get()).toEqual({ group_name: null });
    expect(db.query("SELECT count(*) AS n FROM agent WHERE id LIKE '%-slash'").get()).toEqual({ n: 0 });
    db.close();
    expect((await runCli(dbPath, ["t3", "team", "show", "slash"])).code).toBe(1);
    await runCli(dbPath, ["t3", "team", "add", "empty"]);
    expect((await runCli(dbPath, ["t3", "team", "rm", "empty"])).code).toBe(0);
  });

  test("project rename carries the project's team", async () => {
    const dbPath = await seeded();
    await runCli(dbPath, ["t3", "team", "add", "slash", "--projects", "pixelslash"]);
    expect((await runCli(dbPath, ["project", "rename", "pixelslash", "pixel"])).code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["t3", "team", "show", "slash", "--json"])).out).members).toEqual(["pixel"]);
  });
});

describe("ob t3 architect|sentinel|muse, local (OB-2255 Done when 3, 4)", () => {
  test("--thread writes architect-<team>, titles, pins and turns auto-settle off once each; a second run is idempotent", async () => {
    const dbPath = await seeded();
    await runCli(dbPath, ["t3", "team", "add", "slash", "--icon", "⚔️", "--display-name", "Slash", "--projects", "pixelslash"]);
    const f = t3("thr-a");
    const res = await runCli(dbPath, ["t3", "architect", "slash", "--thread", "thr-a"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("slash architect adopted: architect-slash → thr-a");
    expect(f.renamed).toEqual([{ threadId: "thr-a", title: "⚔️ Slash · architect" }]);
    expect(f.pinned).toEqual(["thr-a"]);
    expect(f.autoSettleOff).toEqual(["thr-a"]);
    expect(f.launches).toEqual([]);
    const db = openDb(dbPath);
    expect(db.query("SELECT launcher, session_id FROM agent WHERE id = 'architect-slash'").get()).toEqual({ launcher: "t3", session_id: "thr-a" });
    db.close();

    const again = await runCli(dbPath, ["t3", "architect", "slash", "--thread", "thr-a"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already live");
    expect(f.renamed).toHaveLength(1);
    expect(f.launches).toEqual([]);
    const plain = await runCli(dbPath, ["t3", "architect", "slash"]);
    expect(plain.code).toBe(0);
    expect(f.launches).toEqual([]);
    const show = await runCli(dbPath, ["t3", "team", "show", "slash"]);
    expect(show.out).toContain("architect: thr-a (architect-slash), pinned");
  });

  test("with no --thread it opens one thread, seeded with /ob-architect and the orientation line, and pins it", async () => {
    const dbPath = await seeded();
    await runCli(dbPath, ["t3", "team", "add", "slash", "--projects", "pixelslash,flakeslash"]);
    const f = t3();
    const res = await runCli(dbPath, ["t3", "architect", "slash"]);
    expect(res.code).toBe(0);
    expect(f.launches).toHaveLength(1);
    const launch = f.launches[0]!;
    expect(launch.title).toBe("slash · architect");
    expect(launch.message).toBe(teamSeedMessage("slash", "architect", ["flakeslash", "pixelslash"], REPO));
    expect((launch.message ?? "").split("\n")[0]).toBe("/ob-architect");
    expect(launch.message).toContain("You are the architect of team `slash` (projects: flakeslash, pixelslash)");
    expect(f.pinned).toEqual(["t3-1"]);
    expect(f.autoSettleOff).toEqual(["t3-1"]);
    // Idempotent: the recorded live thread is kept, nothing else is launched.
    expect((await runCli(dbPath, ["t3", "architect", "slash"])).code).toBe(0);
    expect(f.launches).toHaveLength(1);
  });

  test("in a project with no team, `ob t3 architect` makes the team of one and says so", async () => {
    const dbPath = freshDbPath();
    openDb(dbPath, { create: true }).close();
    await runCli(dbPath, ["project", "add", REPO_SLUG, "--kind", "side"]);
    await runCli(dbPath, ["project", "edit", REPO_SLUG, "--icon", "🚌", "--display-name", "OmniSlash"]);
    const f = t3("thr-o");
    const res = await runCli(dbPath, ["t3", "architect", "--thread", "thr-o"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`${REPO_SLUG} was in no team: made team '${REPO_SLUG}' with it as the only member`);
    expect(f.renamed).toEqual([{ threadId: "thr-o", title: "🚌 OmniSlash · architect" }]);
    expect(JSON.parse((await runCli(dbPath, ["t3", "team", "show", REPO_SLUG, "--json"])).out)).toMatchObject({
      name: REPO_SLUG,
      icon: "🚌",
      display_name: "OmniSlash",
      members: [REPO_SLUG],
      threads: [{ role: "architect", agent_id: `architect-${REPO_SLUG}`, thread_id: "thr-o" }],
    });
    // The team now exists: a second run takes it and makes nothing.
    const again = await runCli(dbPath, ["t3", "architect"]);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("was in no team");
  });

  test("a team of one is written only once the thread is in place: a T3 refusal leaves no team", async () => {
    const dbPath = freshDbPath();
    openDb(dbPath, { create: true }).close();
    await runCli(dbPath, ["project", "add", REPO_SLUG, "--kind", "side"]);
    fake = installFakeT3([]); // T3 knows no project for this checkout
    const res = await runCli(dbPath, ["t3", "architect"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("no T3 project is registered");
    expect((await runCli(dbPath, ["t3", "team", "list", "-q"])).out.trim()).toBe("");
  });

  test("a project in no team whose id names an existing team joins it, and says so; -q keeps stdout to the thread id", async () => {
    const dbPath = freshDbPath();
    openDb(dbPath, { create: true }).close();
    await runCli(dbPath, ["project", "add", REPO_SLUG, "--kind", "side"]);
    await runCli(dbPath, ["t3", "team", "add", REPO_SLUG]);
    t3("thr-j");
    const res = await runCli(dbPath, ["t3", "architect", "--thread", "thr-j", "-q"]);
    expect(res.code).toBe(0);
    expect(res.out).toBe("thr-j\n");
    expect(res.err).toContain(`${REPO_SLUG} was in no team: joined the existing team '${REPO_SLUG}'`);
    expect(JSON.parse((await runCli(dbPath, ["t3", "team", "show", REPO_SLUG, "--json"])).out).members).toEqual([REPO_SLUG]);
  });

  test("sentinel and muse bind their roles (seeds /ob-sentinel, /ob-muse); --remove drops the row and unpins", async () => {
    const dbPath = await seeded();
    await runCli(dbPath, ["t3", "team", "add", "slash", "--icon", "⚔️", "--display-name", "Slash", "--projects", "pixelslash"]);
    const f = t3("thr-s");
    expect((await runCli(dbPath, ["t3", "sentinel", "slash", "--thread", "thr-s"])).code).toBe(0);
    expect(f.renamed).toEqual([{ threadId: "thr-s", title: "⚔️ Slash · sentinel" }]);
    expect(f.pinned).toEqual(["thr-s"]);
    expect((await runCli(dbPath, ["t3", "muse", "slash"])).code).toBe(0);
    expect(f.launches.map((l) => (l.message ?? "").split("\n")[0])).toEqual(["/ob-muse"]);
    expect(f.launches[0]!.title).toBe("⚔️ Slash · muse");
    expect(f.pinned).toEqual(["thr-s", "t3-2"]);
    expect(teamSeedMessage("slash", "sentinel", ["pixelslash"], "/r").split("\n")[0]).toBe("/ob-sentinel");

    const removed = await runCli(dbPath, ["t3", "sentinel", "slash", "--remove"]);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("slash sentinel: removed (sentinel-slash dropped, thread thr-s unpinned)");
    expect(f.unpinned).toEqual(["thr-s"]);
    expect(JSON.parse((await runCli(dbPath, ["t3", "team", "show", "slash", "--json"])).out).threads.map((t: { role: string }) => t.role)).toEqual(["muse"]);
    expect((await runCli(dbPath, ["t3", "sentinel", "slash", "--remove"])).out).toContain("there was none");
    // A sentinel or muse needs a team; --thread and --remove do not go together.
    expect((await runCli(dbPath, ["t3", "muse"])).code).toBe(2);
    expect((await runCli(dbPath, ["t3", "muse", "slash", "--remove", "--thread", "x"])).code).toBe(2);
  });

  test("a thread that is not live is refused, and an unknown team exits 1", async () => {
    const dbPath = await seeded();
    await runCli(dbPath, ["t3", "team", "add", "slash"]);
    const f = t3();
    f.threads.push(liveThread("thr-done", { settled: true }));
    const dead = await runCli(dbPath, ["t3", "architect", "slash", "--thread", "thr-done"]);
    expect(dead.code).toBe(1);
    expect(dead.err).toContain("not a live T3 thread");
    const unknown = await runCli(dbPath, ["t3", "sentinel", "nope", "--thread", "x"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no team 'nope'");
  });
});

describe("unread flags are refused on every ob t3 subcommand (OB-2255 Done when 7)", () => {
  const cases: string[][] = [
    ["t3", "architect", "slash", "--dry-run"],
    ["t3", "sentinel", "slash", "--dry-run"],
    ["t3", "muse", "slash", "--force"],
    ["t3", "architect", "slash", "--remove"],
    ["t3", "team", "add", "x", "--force"],
    ["t3", "team", "edit", "slash", "--projects", "a"],
    ["t3", "team", "join", "slash", "acme", "--icon", "x"],
    ["t3", "team", "leave", "acme", "--dry-run"],
    ["t3", "team", "list", "--force"],
    ["t3", "team", "show", "slash", "--thread", "x"],
    ["t3", "team", "rm", "slash", "--dry-run"],
    ["t3", "broadcast", "architects", "hi", "--force"],
    ["t3", "doctor", "--thread", "x"],
    ["t3", "status", "--dry-run"],
    ["t3", "tree", "--force"],
    ["t3", "projects", "--dry-run"],
    ["t3", "open", "OB-1", "--dry-run"],
    ["t3", "login", "--dry-run"],
  ];
  for (const args of cases) {
    test(`ob ${args.join(" ")} exits 2 naming the flag and calls no seam method`, async () => {
      const dbPath = await seeded();
      await runCli(dbPath, ["t3", "team", "add", "slash"]);
      const f = t3("thr-a");
      const res = await runCli(dbPath, args);
      expect(res.code).toBe(2);
      const flag = args.find((a) => a.startsWith("--"))!;
      expect(res.err).toContain(`does not take ${flag}`);
      expect(seamCalls(f)).toBe(0);
      const db = openDb(dbPath);
      expect(db.query("SELECT count(*) AS n FROM agent").get()).toEqual({ n: 0 });
      db.close();
    });
  }
});

describe("the --team filters (OB-2255 Done when 8)", () => {
  test("ob list --team returns only the team's projects' items, refuses an unknown team, and --group is unknown", async () => {
    const dbPath = await seeded();
    await runCli(dbPath, ["t3", "team", "add", "slash", "--projects", "pixelslash,flakeslash"]);
    const db = openDb(dbPath);
    await createItem(db, { type: "task", title: "pixel thing", projectId: "pixelslash" });
    await createItem(db, { type: "task", title: "flake thing", projectId: "flakeslash" });
    await createItem(db, { type: "task", title: "omni thing", projectId: "acme" });
    db.close();
    const res = await runCli(dbPath, ["list", "--team", "slash", "--json"]);
    expect(res.code).toBe(0);
    expect((JSON.parse(res.out) as Array<{ title: string }>).map((i) => i.title).sort()).toEqual(["flake thing", "pixel thing"]);
    const bad = await runCli(dbPath, ["list", "--team", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("no team 'nope'");
    for (const args of [["list", "--group", "slash"], ["spinoff", "list", "--group", "slash"], ["spinoff", "gateable", "--group", "slash"], ["project", "edit", "acme", "--group", "slash"]]) {
      const r = await runCli(dbPath, args);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("--group");
    }
  });

  test("ob group and ob t3 planner are gone (Done when 1)", async () => {
    const dbPath = await seeded();
    const group = await runCli(dbPath, ["group", "list"]);
    expect(group.code).not.toBe(0);
    expect(group.err).toContain("unknown command");
    const planner = await runCli(dbPath, ["t3", "planner"]);
    expect(planner.code).toBe(2);
    expect(planner.err).toContain("unknown t3 subcommand 'planner'");
  });
});

describe("team helpers (OB-2255)", () => {
  test("ids, titles and the role-row test", () => {
    expect(teamRoleAgentId("slash", "sentinel")).toBe("sentinel-slash");
    expect(teamThreadTitle({ name: "slash", icon: "⚔️", display_name: "Slash" }, "muse")).toBe("⚔️ Slash · muse");
    expect(teamThreadTitle({ name: "acme", icon: null, display_name: null }, "architect")).toBe("acme · architect");
    expect(isTeamRoleAgent("architect-acme")).toBe(true);
    expect(isTeamRoleAgent("muse-slash")).toBe(true);
    expect(isTeamRoleAgent("planner-acme")).toBe(false);
    expect(isTeamRoleAgent("ob-2255")).toBe(false);
  });

  test("teamHandoffTarget: a read that FAILS is a failed route, never taken for no team", async () => {
    const failed = await teamHandoffTarget({
      ticket: "PS-1",
      projectOf: async () => {
        throw new Error("store locked");
      },
      teamOf: async () => "slash",
    });
    expect(failed).toEqual({ kind: "failed", reason: "could not read PS-1's project: store locked" });
    const noProject = await teamHandoffTarget({ ticket: "PS-1", projectOf: async () => null, teamOf: async () => "slash" });
    expect(noProject.kind).toBe("skip");
  });
});

// --- the API path: the CLI's own requests, through the real server, on a real store -------------------

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

async function withApi(fn: (deps: { api: { base: string; token: string; transport: ApiTransport } }, store: Store) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const obApi = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const transport: ApiTransport = async (req) => {
    const res = await obApi(
      new Request(req.url.replace(BASE, "http://api-host.local"), {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
      }),
    );
    return { status: res.status, body: await res.text() };
  };
  try {
    await fn({ api: { base: BASE, token: TOKEN, transport } }, store);
  } finally {
    await store.close?.();
  }
}

describe("ob t3 team and the roles over the API (OB-2255 Done when 2, 3, 4, 7, 8)", () => {
  test("add, join, leave, show, list --team, architect, sentinel --remove and rm, through the server", async () => {
    await withApi(async (deps) => {
      const run = (args: string[]) => runCli(freshDbPath(), args, deps);
      for (const p of ["pixelslash", "flakeslash", "acme"]) expect((await run(["project", "add", p, "--kind", "side"])).code).toBe(0);
      expect((await run(["t3", "team", "add", "slash", "--icon", "⚔️", "--display-name", "Slash", "--projects", "pixelslash"])).code).toBe(0);
      expect((await run(["t3", "team", "join", "slash", "flakeslash"])).code).toBe(0);
      expect((await run(["t3", "team", "add", "omni"])).code).toBe(0);
      const twice = await run(["t3", "team", "join", "omni", "pixelslash"]);
      expect(twice.code).toBe(1);
      expect(twice.err).toContain("already in team 'slash'");
      const unknown = await run(["t3", "team", "show", "nope"]);
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain("no team 'nope'");
      expect((await run(["t3", "team", "join", "nope", "acme"])).code).toBe(1);
      expect((await run(["t3", "team", "leave", "flakeslash"])).code).toBe(0);
      expect(JSON.parse((await run(["t3", "team", "show", "slash", "--json"])).out).members).toEqual(["pixelslash"]);

      expect((await run(["add", "pixel thing", "--project", "pixelslash"])).code).toBe(0);
      expect((await run(["add", "omni thing", "--project", "acme"])).code).toBe(0);
      expect((JSON.parse((await run(["list", "--team", "slash", "--json"])).out) as Array<{ title: string }>).map((i) => i.title)).toEqual(["pixel thing"]);
      expect((await run(["list", "--team", "nope"])).code).toBe(1);

      const f = t3("thr-a", "thr-s");
      const refusedFlag = await run(["t3", "architect", "slash", "--dry-run"]);
      expect(refusedFlag.code).toBe(2);
      expect(seamCalls(f)).toBe(0);
      expect((await run(["t3", "architect", "slash", "--thread", "thr-a"])).code).toBe(0);
      expect(f.renamed).toEqual([{ threadId: "thr-a", title: "⚔️ Slash · architect" }]);
      expect(f.pinned).toEqual(["thr-a"]);
      expect(f.autoSettleOff).toEqual(["thr-a"]);
      expect((await run(["t3", "architect", "slash", "--thread", "thr-a"])).out).toContain("already live");
      expect((await run(["t3", "sentinel", "slash", "--thread", "thr-s"])).code).toBe(0);
      expect(JSON.parse((await run(["t3", "team", "list", "--json"])).out).find((t: { name: string }) => t.name === "slash")).toMatchObject({
        threads: [
          { role: "architect", agent_id: "architect-slash", thread_id: "thr-a" },
          { role: "sentinel", agent_id: "sentinel-slash", thread_id: "thr-s" },
        ],
      });
      expect((await run(["t3", "sentinel", "slash", "--remove"])).code).toBe(0);
      expect(f.unpinned).toEqual(["thr-s"]);

      const refused = await run(["t3", "team", "rm", "slash"]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("still has members pixelslash");
      expect((await run(["t3", "team", "rm", "slash", "--force"])).code).toBe(0);
      expect(f.unpinned).toEqual(["thr-s", "thr-a"]);
      expect(JSON.parse((await run(["t3", "team", "list", "--json"])).out).map((t: { name: string }) => t.name)).toEqual(["omni"]);
    });
  });
});


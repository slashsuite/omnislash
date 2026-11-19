// `ob role brief <team> <role>` and `ob role note <team> <role>` (OS-55).
// The renderer and the pacing read are tested pure, on fixtures and a fixed `now`. The note and the brief are tested
// through the CLI twice: locally against a throwaway SQLite store, and over the API, where the CLI's own requests go
// through `createObApi` on a real Postgres store (a local cluster, no network, no live database).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli, type CliResult } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { openStore, sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { markRoleRun, updateRoleRun, type RoleRun } from "../../../apps/cli/src/role-run.ts";
import { sendRoleMessage, type RoleMessage } from "../../../apps/cli/src/inbox.ts";
import { registerAgent } from "../../cli-coord/src/agent.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { readPacing, renderRoleBrief, roleBriefStoreFacts, type RoleBriefFacts } from "../../../apps/cli/src/role-brief.ts";

const scratch = mkdtempSync(join(tmpdir(), "ob-role-brief-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SECTIONS = [
  "## Team",
  "## Pacing",
  "## Rows in flight",
  "## PRs to gate",
  "## Unread inbox",
  "## Open asks for the owner",
  "## Next three",
  "## Skill",
  "## Note from the last run",
];

/** The body under one `## ` heading, up to the next. Pure. */
function sectionOf(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const at = lines.indexOf(heading);
  if (at < 0) throw new Error(`no ${heading} in:\n${text}`);
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("## ")) break;
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function message(id: number, body: string): RoleMessage {
  return {
    id,
    team: "t",
    role: "architect",
    from_actor: "owner",
    kind: "message",
    ref: null,
    body,
    client_key: null,
    created_at: "2026-11-19T00:00:00.000Z",
    read_at: null,
    read_by: null,
    withdrawn_at: null,
  };
}

function emptyFacts(): RoleBriefFacts {
  return {
    team: { name: "t", display_name: null, icon: null },
    role: "architect",
    projects: [],
    threads: [],
    rows: [],
    inbox: [],
    asks: [],
    next: [],
    next_total: 0,
    note: null,
    pacing: { known: false, reason: "no readable usage cache at /nowhere" },
    gate: [],
  };
}

/** Every list well over its cap, and a 40-line note of long lines. */
function maximalFacts(): RoleBriefFacts {
  const n = (k: number) => Array.from({ length: k }, (_, i) => i + 1);
  return {
    team: { name: "slash", display_name: "Slash", icon: "⚔️" },
    role: "sentinel",
    projects: n(14).map((i) => ({ id: `p${i}`, name: `p${i}`, stage: "alpha" })),
    threads: [
      { role: "architect", agent_id: "architect-slash", thread_id: "thread-a" },
      { role: "sentinel", agent_id: "sentinel-slash", thread_id: "thread-s" },
      { role: "muse", agent_id: "muse-slash", thread_id: "thread-m" },
    ],
    rows: n(25).map((i) => ({ id: i, ticket_ref: `PS-${i}`, status: "launched", tier: "complex", branch: `ps-${i}`, worktree: `/w/ps-${i}`, repo: "p1" })),
    inbox: n(30).map((i) => message(i, `${"x".repeat(400)}\nsecond line`)),
    asks: n(12).map((i) => ({ id: `ps-${i}`, note: "is the empty-state wording right?" })),
    next: n(3).map((i) => ({ ref: `PS-${100 + i}`, priority: "high", title: `queued item ${i}` })),
    next_total: 40,
    note: { run_id: 7, note_at: "2026-11-19T00:00:00.000Z", body: n(40).map((i) => `note line ${i} ${"y".repeat(90)}`).join("\n") },
    pacing: { known: true, used_percent: 44, elapsed_percent: 22, resets_at: "2026-11-24T00:00:00Z", ahead: true },
    gate: n(18).map((i) => ({ ref: `PS-${i}`, branch: `ps-${i}`, state: "State: landable\nGate: green", missing: false })),
  };
}

describe("renderRoleBrief", () => {
  test("prints the nine sections in order, with every fact in its section", () => {
    const f = maximalFacts();
    f.rows = f.rows.slice(0, 2);
    f.gate = [
      { ref: "PS-1", branch: "ps-1", state: "State: landable\nGate: green", missing: false },
      { ref: "PS-2", branch: "ps-2", state: null, missing: true },
    ];
    f.inbox = [message(3, "first line\nsecond line")];
    f.asks = [{ id: "ps-4", note: "which wording?" }];
    f.projects = f.projects.slice(0, 2);
    f.next_total = 3;
    f.note = { run_id: 2, note_at: "2026-11-19T00:00:00.000Z", body: "keep the gate green\nwatch PS-9\n" };
    const text = renderRoleBrief(f);
    const at = SECTIONS.map((s) => text.split("\n").indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text.split("\n")[0]).toBe("# Brief for slash sentinel");
    expect(sectionOf(text, "## Team")).toEqual([
      "slash (Slash); you are the sentinel",
      "Threads: architect thread-a, sentinel thread-s, muse thread-m",
      "Project p1: alpha",
      "Project p2: alpha",
    ]);
    expect(sectionOf(text, "## Pacing")).toEqual(["44% used, 22% of the week gone, resets 2026-11-24T00:00:00Z; ahead"]);
    expect(sectionOf(text, "## Rows in flight")).toEqual(["PS-1 building, tier complex, branch ps-1", "PS-2 building, tier complex, branch ps-2"]);
    expect(sectionOf(text, "## PRs to gate")).toEqual(["PS-1 ps-1: State: landable", "PS-2 ps-2: worktree missing"]);
    expect(sectionOf(text, "## Unread inbox")).toEqual(["#3 from owner (message): first line"]);
    expect(sectionOf(text, "## Open asks for the owner")).toEqual(["ps-4: which wording?"]);
    expect(sectionOf(text, "## Next three")).toEqual(["PS-101 high: queued item 1", "PS-102 high: queued item 2", "PS-103 high: queued item 3"]);
    expect(sectionOf(text, "## Skill")).toEqual(["Load /ob-sentinel."]);
    expect(sectionOf(text, "## Note from the last run")).toEqual(["keep the gate green", "watch PS-9"]);
  });

  test("empty sections say none, and a missing note says none", () => {
    const text = renderRoleBrief(emptyFacts());
    for (const s of ["## Rows in flight", "## PRs to gate", "## Unread inbox", "## Open asks for the owner", "## Next three", "## Note from the last run"]) {
      expect(sectionOf(text, s)).toEqual(["none"]);
    }
    expect(sectionOf(text, "## Team")).toEqual(["t; you are the architect", "Threads: none bound"]);
    expect(sectionOf(text, "## Pacing")).toEqual(["unknown (no readable usage cache at /nowhere)"]);
    expect(sectionOf(text, "## Skill")).toEqual(["Load /ob-architect."]);
  });

  test("a maximal fixture stays within 150 lines, and every capped list ends with +N more", () => {
    const text = renderRoleBrief(maximalFacts());
    expect(text.split("\n").length).toBeLessThanOrEqual(150);
    const ends = (s: string, more: string, count: number) => {
      const body = sectionOf(text, s);
      expect(body).toHaveLength(count + 1);
      expect(body[body.length - 1]).toBe(more);
    };
    ends("## Rows in flight", "+15 more", 10);
    ends("## PRs to gate", "+8 more", 10);
    ends("## Unread inbox", "+20 more", 10);
    ends("## Open asks for the owner", "+2 more", 10);
    ends("## Next three", "+37 more", 3);
    const team = sectionOf(text, "## Team");
    expect(team[team.length - 1]).toBe("+4 more");
    // An inbox line is the body's first line, cut to 160 characters.
    const inbox = sectionOf(text, "## Unread inbox")[0]!;
    expect(inbox.slice("#1 from owner (message): ".length)).toHaveLength(160);
    expect(sectionOf(text, "## Note from the last run")).toHaveLength(40);
  });
});

describe("readPacing (fixed now)", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  /** A cache whose seven-day window has `gonePercent` of the week gone at `now`. */
  function cache(name: string, usedPercent: number, gonePercent: number, checkedAt: string): string {
    const mins = 10080;
    const resetsAt = new Date(now.getTime() + ((100 - gonePercent) / 100) * mins * 60_000).toISOString();
    const file = join(scratch, name);
    writeFileSync(file, JSON.stringify({ checkedAt, usageLimits: { windows: [{ id: "seven_day", usedPercent, resetsAt, windowDurationMins: mins }] } }));
    return file;
  }

  test("44% used at 22% of the week gone reads ahead", () => {
    const p = readPacing(cache("ahead.json", 44, 22, "2026-11-19T11:50:00.000Z"), now);
    expect(p).toMatchObject({ known: true, used_percent: 44, ahead: true });
    if (p.known) expect(Math.round(p.elapsed_percent)).toBe(22);
  });

  test("30% used at 22% of the week gone is not ahead", () => {
    expect(readPacing(cache("behind.json", 30, 22, "2026-11-19T11:50:00.000Z"), now)).toMatchObject({ known: true, used_percent: 30, ahead: false });
  });

  test("a checkedAt two hours old reads unknown", () => {
    const p = readPacing(cache("stale.json", 44, 22, "2026-11-19T10:00:00.000Z"), now);
    expect(p.known).toBe(false);
    expect(renderRoleBrief({ ...emptyFacts(), pacing: p }).split("\n")).toContain("unknown (the usage cache was last checked 2026-11-19T10:00:00.000Z, over an hour ago)");
  });

  test("a missing cache reads unknown", () => {
    expect(readPacing(join(scratch, "absent.json"), now)).toMatchObject({ known: false });
  });
});

// --- through the CLI, on both stores -----------------------------------------------------------------------

interface Harness {
  run(args: string[]): Promise<CliResult>;
  store: Store;
}

/** Team `t` with project `acme` in it, one queued item there, and an ended architect run. */
async function seed(h: Harness): Promise<void> {
  expect((await h.run(["t3", "team", "add", "t"])).code).toBe(0);
  await registerProject(h.store, { name: "acme", kind: "side" });
  await createItem(h.store, { type: "task", title: "the next thing", projectId: "acme" });
  expect((await h.run(["t3", "team", "join", "t", "acme"])).code).toBe(0);
  const { run } = await markRoleRun(h.store, { team: "t", role: "architect", t3Host: "http://t3.test" });
  await updateRoleRun(h.store, "t", run.id, { end_reason: "manual" });
}

async function local(): Promise<Harness> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath, { create: true });
  const h: Harness = { run: (args) => runCli(dbPath, args), store: sqliteStoreFor(db) };
  await seed(h);
  return h;
}

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

async function withApi(fn: (h: Harness) => Promise<void>): Promise<void> {
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
  const deps = { api: { base: BASE, token: TOKEN, transport } };
  const h: Harness = { run: (args) => runCli(freshDbPath(), args, deps), store };
  try {
    await seed(h);
    await fn(h);
  } finally {
    await store.close?.();
  }
}

async function runs(store: Store): Promise<RoleRun[]> {
  const t = store.t.roleRun;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleRun[];
}

function noteFile(name: string, body: string): string {
  const file = join(scratch, name);
  writeFileSync(file, body);
  return file;
}

async function brief(h: Harness, extra: string[] = []): Promise<string> {
  const res = await h.run(["role", "brief", "t", "architect", ...extra]);
  expect(res.err).toBe("");
  expect(res.code).toBe(0);
  return res.out;
}

const CASES: Array<[string, (h: Harness) => Promise<void>]> = [
  [
    "a note of 41 lines, or of 4001 characters, exits 2 naming the count and the limit, and stores nothing",
    async (h) => {
      const lines = noteFile("41.md", Array.from({ length: 41 }, (_, i) => `line ${i + 1}`).join("\n"));
      const long = await h.run(["role", "note", "t", "architect", "--body-file", lines]);
      expect(long.code).toBe(2);
      expect(long.err).toContain("the note is 41 lines and");
      expect(long.err).toContain("the limit is 40 lines and 4000 characters");
      const chars = noteFile("4001.md", "z".repeat(4001));
      const wide = await h.run(["role", "note", "t", "architect", "--body-file", chars]);
      expect(wide.code).toBe(2);
      expect(wide.err).toContain("the note is 1 lines and 4001 characters; the limit is 40 lines and 4000 characters");
      expect((await runs(h.store)).map((r) => r.successor_note)).toEqual([null]);
    },
  ],
  [
    "a brief prints the nine sections in order with the note once; a second prints none; --peek leaves it waiting",
    async (h) => {
      await sendRoleMessage(h.store, { team: "t", role: "architect", from: "owner", kind: "message", body: "look at PS-1\nmore" });
      await registerAgent(h.store, { id: "sentinel-t", worktree: "/r", status: "needs-human", note: "merge it?", launcher: "t3", sessionId: "s-thread", ttlS: 900 });
      const stored = await h.run(["role", "note", "t", "architect", "--body-file", noteFile("note.md", "keep the gate green\nwatch PS-9\n")]);
      expect(stored.code).toBe(0);
      expect(stored.out).toContain("t architect: note stored on run 1 (2 lines)");

      const peeked = await brief(h, ["--peek"]);
      expect(sectionOf(peeked, "## Note from the last run")).toEqual(["keep the gate green", "watch PS-9"]);
      expect((await runs(h.store))[0]!.note_shown_at).toBeNull();
      // The store read (the API's GET) never consumes the note, so a retried or lost reply cannot lose it.
      expect((await roleBriefStoreFacts(h.store, "t", "architect")).note?.body).toMatch(/^keep the gate green\nwatch PS-9\n?$/);
      expect((await runs(h.store))[0]!.note_shown_at).toBeNull();

      const first = await brief(h);
      const at = SECTIONS.map((s) => first.split("\n").indexOf(s));
      expect(at.every((i) => i > 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(sectionOf(first, "## Team")).toEqual(["t; you are the architect", "Threads: sentinel s-thread", "Project acme: beta (not set)"]);
      expect(sectionOf(first, "## Unread inbox")).toEqual([expect.stringMatching(/^#\d+ from owner \(message\): look at PS-1$/)]);
      expect(sectionOf(first, "## Open asks for the owner")).toEqual(["sentinel-t: merge it?"]);
      expect(sectionOf(first, "## Next three")).toEqual([expect.stringMatching(/^\S+ \S+: the next thing$/)]);
      expect(sectionOf(first, "## Skill")).toEqual(["Load /ob-architect."]);
      expect(sectionOf(first, "## Note from the last run")).toEqual(["keep the gate green", "watch PS-9"]);
      expect((await runs(h.store))[0]!.note_shown_at).not.toBeNull();

      const second = await brief(h);
      expect(sectionOf(second, "## Note from the last run")).toEqual(["none"]);
    },
  ],
  [
    "a second note on the same run replaces the first and waits to be shown again",
    async (h) => {
      expect((await h.run(["role", "note", "t", "architect", "--body", "first"])).code).toBe(0);
      expect(sectionOf(await brief(h), "## Note from the last run")).toEqual(["first"]);
      expect((await h.run(["role", "note", "t", "architect", "--body", "second"])).code).toBe(0);
      const [run] = await runs(h.store);
      expect(run).toMatchObject({ successor_note: "second", note_shown_at: null });
      expect(sectionOf(await brief(h), "## Note from the last run")).toEqual(["second"]);
    },
  ],
  [
    "a role with no run refuses the note by name",
    async (h) => {
      const res = await h.run(["role", "note", "t", "muse", "--body", "hello"]);
      expect(res.code).toBe(1);
      expect(res.err).toContain("t muse has no run to leave a note on");
    },
  ],
];

describe("ob role note and ob role brief, locally (SQLite)", () => {
  for (const [name, fn] of CASES) test(name, async () => fn(await local()));
});

describe("ob role note and ob role brief, over the API (Postgres)", () => {
  for (const [name, fn] of CASES) test(name, async () => withApi(fn), 60_000);
});

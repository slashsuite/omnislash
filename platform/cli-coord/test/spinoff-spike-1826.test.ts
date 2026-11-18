// OB-1826: a spike is a bounded investigation, an ordinary ticket tagged `spike` and linked to the ticket it
// serves. It may edit, test and run commands, and never commits code (OB-2227: documentation only). These tests
// pin the four ways the tool keeps it that way: the dispatch gate (the three sections and the link), a handoff
// that skips the dirty check and stamps nothing, a handoff that refuses a commit touching anything but
// documentation, and a close that retires the row without calling it a landing.
// In-process against a fresh SQLite database, a fake T3 and a fake shell: no network, no live store. Tests
// cannot show a real spike passing through; the architect runs one after the land (the ticket's live Done-when item).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRepoDir, freshDbPath, runCli, omnislashTeamFor } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { addLink, addTags, createItem } from "../../../apps/cli/src/items.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { __setT3Seam, isReadyingNoteFor, spikeAnsweredNote, spikeClosedNote, splitOwnRows, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import type { T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import { registerAgent } from "../src/agent.ts";
import { __setSh, changedPathsFor, enqueueSpinoff } from "../src/commands/spinoff.ts";
import { buildMix, type MixSource } from "../src/spinoff-mix.ts";
import {
  isSpikeDocPath,
  isSpikeEnd,
  isSpikeTagged,
  missingSpikeSections,
  spikeCommitRefusal,
  spikeEndError,
  spikeGateMissing,
} from "../src/spinoff-spike.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

const BODY = "Why: a number is guessed.\n\n## Questions\n- does the cache key include the repo?\n\n## Box\nTwo hours; read-only on prod.\n\n## Done when\n- the notes on the parent answer the question with a command's output\n";

interface Seeded {
  dbPath: string;
  parent: string;
  spike: string;
  repo: string;
}

/** A parent ticket, and a spike ticket tagged `spike` (or `tag`), linked to it unless `link` is false. */
async function seedTickets(opts: { body?: string; tag?: string; link?: boolean } = {}): Promise<Seeded> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath);
  const parent = await createItem(db, { type: "task", title: "the ticket that cannot reach 7", body: "Need stated." });
  const spike = await createItem(db, { type: "task", title: "spike: find out", body: opts.body ?? BODY });
  await addTags(db, spike, [opts.tag ?? "spike"]);
  if (opts.link !== false) await addLink(db, spike, "spun_off_from", parent);
  db.close();
  return { dbPath, parent, spike, repo: fakeRepoDir() };
}

const rowCount = async (dbPath: string): Promise<number> => JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out).length;

/** A dispatch with T3 and the shell faked: a launch is recorded, never made. */
async function dispatch(dbPath: string, id: string, repo: string, ...extra: string[]) {
  const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
  const t3 = installFakeT3([repo]);
  const wt = mkdtempSync(join(tmpdir(), "ob-1826-"));
  try {
    const r = await runCli(dbPath, ["spinoff", id, "--repo", repo, "--branch", `build-${id}`, "--worktree", wt, "--brief", "b", ...extra]);
    return { ...r, launches: t3.launches.length };
  } finally {
    t3.restore();
    restoreSh();
    rmSync(wt, { recursive: true, force: true });
  }
}

describe("the pure rules (OB-1826)", () => {
  test("the tag is matched exactly: a `spike-mechanism` ticket is not a spike", () => {
    expect(isSpikeTagged(["spike"])).toBe(true);
    expect(isSpikeTagged(["Spike"])).toBe(true);
    expect(isSpikeTagged(["spike-mechanism"])).toBe(false);
    expect(isSpikeTagged(["spikes", "feature"])).toBe(false);
    expect(isSpikeTagged([])).toBe(false);
  });

  test("a section counts only with content under it", () => {
    expect(missingSpikeSections(BODY)).toEqual([]);
    expect(missingSpikeSections("## Questions\n- q\n\n## Box\n\n## Done when\n- d")).toEqual(["## Box"]);
    expect(missingSpikeSections("prose")).toEqual(["## Questions", "## Box", "## Done when"]);
    expect(spikeGateMissing(BODY, false)).toHaveLength(1);
    expect(spikeGateMissing(BODY, false)[0]).toContain("spun_off_from");
    expect(spikeGateMissing(BODY, true)).toEqual([]);
  });

  test("a spike end is a failed row whose error carries the marker; a failed launch is not one", () => {
    expect(spikeEndError("answered")).toBe("spike: answered");
    expect(spikeEndError("  ")).toBe("spike: closed with no note");
    expect(isSpikeEnd({ status: "failed", error: "spike: answered" })).toBe(true);
    expect(isSpikeEnd({ status: "failed", error: "launch blew up" })).toBe(false);
    expect(isSpikeEnd({ status: "merged", error: "spike: x" })).toBe(false);
    expect(isSpikeEnd({ status: "launched", error: null })).toBe(false);
  });

  test("a branch that changes only documentation passes; any other path, or an unreadable branch, is refused by name (OB-2227)", () => {
    const row = { ticket_ref: "OB-9", branch: "ob-9", worktree: "/wt/ob-9" };
    expect(spikeCommitRefusal(row, [])).toBeNull();
    expect(spikeCommitRefusal(row, ["docs/research/x.md"])).toBeNull();
    expect(spikeCommitRefusal(row, ["docs/research/x.md", "notes/plan.md", "README.md"])).toBeNull();
    expect(spikeCommitRefusal(row, null)).toContain("cannot tell");
  });

  test("documentation is a .md file outside the code roots and skills/ (OB-2227)", () => {
    expect(isSpikeDocPath("docs/research/x.md")).toBe(true);
    expect(isSpikeDocPath("wiki/incidents/ops.md")).toBe(true);
    expect(isSpikeDocPath("docs/x.ts")).toBe(false);
    expect(isSpikeDocPath("docs/diagram.png")).toBe(false);
    for (const p of ["apps/cli/README.md", "platform/cli-coord/x.md", "domains/health/x.md", "skills/ob-architect/SKILL.md", "ops/x.md"]) {
      expect(isSpikeDocPath(p)).toBe(false);
    }
  });
});

describe("the dispatch gate (OB-1826)", () => {
  async function expectRefused(s: Seeded, ...needles: string[]) {
    const launch = await dispatch(s.dbPath, s.spike, s.repo);
    expect(launch.code).not.toBe(0);
    expect(launch.err).toContain("not dispatched");
    expect(launch.err).toContain("tagged spike");
    expect(launch.err).toContain("Nothing was queued");
    for (const needle of needles) expect(launch.err).toContain(needle);
    expect(launch.launches).toBe(0);
    expect(await rowCount(s.dbPath)).toBe(0);
  }

  test("no `## Questions`: refused by name, no row", async () => {
    await expectRefused(await seedTickets({ body: "## Box\nb\n\n## Done when\n- d" }), "## Questions");
  });
  test("no `## Box`: refused by name, no row", async () => {
    await expectRefused(await seedTickets({ body: "## Questions\n- q\n\n## Done when\n- d" }), "## Box");
  });
  test("no `## Done when`: refused by name, no row", async () => {
    await expectRefused(await seedTickets({ body: "## Questions\n- q\n\n## Box\nb" }), "## Done when");
  });
  test("no `spun_off_from` link: refused by name, no row", async () => {
    await expectRefused(await seedTickets({ link: false }), "spun_off_from");
  });
  test("all missing at once: every piece is named", async () => {
    await expectRefused(await seedTickets({ body: "prose", link: false }), "## Questions", "## Box", "## Done when", "spun_off_from");
  });

  test("a complete spike launches with NO recorded check", async () => {
    const s = await seedTickets();
    const launch = await dispatch(s.dbPath, s.spike, s.repo);
    expect(launch.err).not.toContain("not dispatched");
    expect(launch.code).toBe(0);
    expect(launch.launches).toBe(1);
    expect(await rowCount(s.dbPath)).toBe(1);
  });

  test("`--no-check` still overrides, and an incomplete spike launches", async () => {
    const s = await seedTickets({ body: "prose", link: false });
    const launch = await dispatch(s.dbPath, s.spike, s.repo, "--no-check", "tried it; the gate is wrong here");
    expect(launch.code).toBe(0);
    expect(await rowCount(s.dbPath)).toBe(1);
  });

  test("a ticket tagged `spike-mechanism` is gated as an ordinary ticket, not as a spike", async () => {
    const s = await seedTickets({ tag: "spike-mechanism", body: "Need stated.\n\n## Drilled\n- read the code\n\n## Done when\n- a test shows it", link: false });
    const launch = await dispatch(s.dbPath, s.spike, s.repo);
    expect(launch.code).not.toBe(0);
    expect(launch.err).toContain("no measure-twice check");
    expect(launch.err).not.toContain("tagged spike");
  });
});

/** A spike row on a real item, in a temp worktree, with an architect and a builder thread registered. */
async function seedSpikeRow(s: Seeded, repo = "/r/omnislash"): Promise<{ wt: string; rowId: number }> {
  const wt = mkdtempSync(join(tmpdir(), "ob-wt-1826-"));
  restores.push(() => rmSync(wt, { recursive: true, force: true }));
  const db = openDb(s.dbPath, { create: true });
  const { row } = await enqueueSpinoff(db, { ticketRef: s.spike, repo, branch: "spike-branch", mode: "interactive", brief: "b", worktree: wt });
  db.query(
    "UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ?, launcher = 't3', t3_thread_id = ?, item_id = ?, base_sha = 'base123' WHERE id = ?",
  ).run(s.spike, wt, "builder-thread-1", s.spike, row.id);
  await registerAgent(db, { id: s.spike, ticket: s.spike, branch: "spike-branch", worktree: wt, status: "working", ttlS: 900 });
  omnislashTeamFor(db, s.spike);
  await registerAgent(db, { id: "architect-omnislash", worktree: "/r/omnislash", status: "planning", launcher: "t3", sessionId: "architect-thread-1", ttlS: 900 });
  db.close();
  return { wt, rowId: row.id };
}

const rowOf = (dbPath: string, id: number): { status: string; error: string | null } => {
  const db = openDb(dbPath);
  const r = db.query("SELECT status, error FROM spinoff WHERE id = ?").get(id) as { status: string; error: string | null };
  db.close();
  return r;
};

/** A seam that records sends and settles; `queue` reads as an empty, complete queue. */
function fakeSeam(): { seam: T3Seam; sends: T3SendInput[]; settled: string[] } {
  const fake = { sends: [] as T3SendInput[], settled: [] as string[], seam: {} as T3Seam };
  const unimplemented = (name: string) => async () => {
    throw new Error(`${name} is not used by the handoff/close paths`);
  };
  fake.seam = {
    interrupt: async () => {},
    projects: unimplemented("projects") as T3Seam["projects"],
    capabilities: unimplemented("capabilities") as T3Seam["capabilities"],
    list: unimplemented("list") as T3Seam["list"],
    read: unimplemented("read") as T3Seam["read"],
    launch: unimplemented("launch") as T3Seam["launch"],
    rename: unimplemented("rename") as T3Seam["rename"],
    settle: async (threadId) => {
      fake.settled.push(threadId);
    },
    send: async (input) => {
      fake.sends.push(input);
    },
    queue: async () => ({ items: [], complete: true }),
    pin: async () => {},
    unpin: async () => {},
    disableAutoSettle: async () => {},
    queueCancel: async () => {},
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
  };
  return fake;
}

/**
 * Git and gh stubs: a DIRTY checkout (a spike tries things), `changed` paths past the base (OB-2227: the
 * commit count follows from them), no `State:` line, and `gh pr view` either printing an open PR (`pr`), or
 * failing (`pr: "fail"`, the default: no PR).
 */
function fakeGit(changed: string[] | null = [], pr: { url: string } | "fail" = "fail", log = ""): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("--porcelain")) return { ok: true, err: "", out: " M apps/cli/src/scratch.ts\n?? probe.log\n" };
      if (line.includes("diff --name-only")) return changed === null ? { ok: false, err: "fatal: bad object", out: "" } : { ok: true, err: "", out: changed.join("\n") + "\n" };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: `${changed && changed.length > 0 ? 1 : 0}\n` };
      if (line.includes(" log --format=%B")) return { ok: true, err: "", out: log };
      if (line.startsWith("gh pr view")) {
        return pr === "fail" ? { ok: false, err: "no pull requests found for branch", out: "" } : { ok: true, err: "", out: JSON.stringify({ url: pr.url, state: "OPEN" }) };
      }
      return { ok: true, err: "", out: "" };
    }),
  );
}

describe("ob spinoff handoff on a spike (OB-1826)", () => {
  test("a dirty worktree with no commit succeeds; the row is not ready-for-gate and not gateable", async () => {
    const s = await seedTickets();
    const { rowId } = await seedSpikeRow(s);
    fakeGit();
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(s.dbPath, ["spinoff", "handoff", s.spike]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("spike answered");
    expect(res.out).not.toContain("handed off");
    expect(rowOf(s.dbPath, rowId).status).toBe("launched");

    const gateable = await runCli(s.dbPath, ["spinoff", "gateable", "--json"]);
    expect(JSON.parse(gateable.out)).toEqual([]);

    // The architect is told, in words that fit a spike: the note says there is nothing to gate.
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.threadId).toBe("architect-thread-1");
    expect(fake.sends[0]!.message).toContain("spike answered");
    expect(fake.sends[0]!.message).not.toContain("gate and merge");
  });

  test("`--note` still goes on the ticket's trail", async () => {
    const s = await seedTickets();
    await seedSpikeRow(s);
    fakeGit();
    restores.push(__setT3Seam(fakeSeam().seam));

    expect((await runCli(s.dbPath, ["spinoff", "handoff", s.spike, "--note", "the cache key is per repo"])).code).toBe(0);
    expect((await runCli(s.dbPath, ["show", s.spike])).out).toContain("the cache key is per repo");
  });

  /** Hand off a spike whose branch changes `changed`, and expect a refusal naming each of `named`; the row does not move. */
  async function expectRefused(changed: string[] | null, ...named: string[]) {
    const s = await seedTickets();
    const { rowId } = await seedSpikeRow(s);
    fakeGit(changed);
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(s.dbPath, ["spinoff", "handoff", s.spike]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("spike-branch");
    expect(res.err).toContain("documentation only");
    expect(res.err).toContain("Nothing was handed off");
    for (const n of named) expect(res.err).toContain(n);
    expect(rowOf(s.dbPath, rowId).status).toBe("launched");
    expect(JSON.parse((await runCli(s.dbPath, ["spinoff", "gateable", "--json"])).out)).toEqual([]);
    expect(fake.sends).toHaveLength(0);
    return res;
  }

  test("a branch that commits only docs/research/x.md hands off (OB-2227)", async () => {
    const s = await seedTickets();
    const { rowId } = await seedSpikeRow(s);
    fakeGit(["docs/research/x.md"]);
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(s.dbPath, ["spinoff", "handoff", s.spike]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("spike answered");
    expect(res.out).toContain("documentation commit");
    expect(rowOf(s.dbPath, rowId).status).toBe("launched");
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.message).toContain("committed documentation only");
  });

  test("docs plus a file under apps/ is refused, naming that file and not the doc (OB-2227)", async () => {
    const res = await expectRefused(["docs/research/x.md", "apps/cli/src/x.ts"], "apps/cli/src/x.ts");
    expect(res.err).not.toContain("docs/research/x.md");
  });

  test("code only is refused, naming it (OB-2227)", async () => {
    await expectRefused(["platform/cli-coord/src/x.ts"], "platform/cli-coord/src/x.ts");
  });

  test("docs/x.ts is refused, naming it: under docs/ only .md counts (OB-2227)", async () => {
    await expectRefused(["docs/x.ts"], "docs/x.ts");
  });

  test("an unreadable branch is refused (OB-2227)", async () => {
    await expectRefused(null, "cannot tell");
  });

  test("an open PR for the doc commit is named in the architect note and the report (OB-2227)", async () => {
    const s = await seedTickets();
    await seedSpikeRow(s);
    const url = "https://github.com/o/r/pull/77";
    fakeGit(["docs/research/x.md"], { url });
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(s.dbPath, ["spinoff", "handoff", s.spike]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(url);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.message).toContain(url);
    expect(fake.sends[0]!.message).not.toContain("no commit and no PR");
  });

  test("a spike's doc commit in a clean repo is checked for ob leaks like a build (OB-2227)", async () => {
    const s = await seedTickets();
    const { rowId } = await seedSpikeRow(s, "/r/hackcove");
    fakeGit(["docs/research/x.md"], "fail", "docs(OB-2): the report\n\nState: landable\n");
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(s.dbPath, ["spinoff", "handoff", s.spike]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("State:");
    expect(rowOf(s.dbPath, rowId).status).toBe("launched");
    expect(fake.sends).toHaveLength(0);
  });

  test("gh failing still hands off, with no URL in the note (OB-2227)", async () => {
    const s = await seedTickets();
    await seedSpikeRow(s);
    fakeGit(["docs/research/x.md"], "fail");
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(s.dbPath, ["spinoff", "handoff", s.spike]);
    expect(res.code).toBe(0);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.message).not.toContain("https://");
    expect(fake.sends[0]!.message).toContain("no open PR was found");
  });

  test("an ordinary ticket still refuses a dirty worktree (the spike rule is the tag's, not a loosening)", async () => {
    const s = await seedTickets({ tag: "feature" });
    const { rowId } = await seedSpikeRow(s);
    fakeGit();
    restores.push(__setT3Seam(fakeSeam().seam));
    const res = await runCli(s.dbPath, ["spinoff", "handoff", s.spike]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("worktree is dirty");
    expect(rowOf(s.dbPath, rowId).status).toBe("launched");
  });
});

/** Run git in `dir`, failing loudly. */
function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe("changedPathsFor against a real git repo (OB-2227)", () => {
  /** A repo on `main` with apps/a.ts, apps/b.ts and apps/c.ts, and a `spike` branch cut from it. Returns the base SHA. */
  function seedRepo(): { dir: string; base: string } {
    const dir = mkdtempSync(join(tmpdir(), "ob-2227-git-"));
    restores.push(() => rmSync(dir, { recursive: true, force: true }));
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "apps"));
    for (const f of ["a", "b", "c"]) writeFileSync(join(dir, "apps", `${f}.ts`), `export const ${f} = 1;\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const base = git(dir, "rev-parse", "HEAD");
    git(dir, "branch", "spike");
    return { dir, base };
  }

  test("a deletion and both sides of a rename are listed", () => {
    const { dir, base } = seedRepo();
    git(dir, "checkout", "-q", "spike");
    git(dir, "rm", "-q", "apps/a.ts");
    git(dir, "mv", "apps/b.ts", "docs-b.md");
    git(dir, "commit", "-q", "-m", "move");
    const paths = changedPathsFor(dir, "spike", base)!;
    expect(paths.sort()).toEqual(["apps/a.ts", "apps/b.ts", "docs-b.md"]);
    expect(spikeCommitRefusal({ ticket_ref: "OB-9", branch: "spike", worktree: dir }, paths)).toContain("apps/a.ts");
  });

  test("a docs-only spike rebased onto a main that changed apps/ is charged only with its own doc", () => {
    const { dir, base } = seedRepo();
    writeFileSync(join(dir, "apps", "c.ts"), "export const c = 2;\n");
    git(dir, "commit", "-q", "-am", "main moves on");
    git(dir, "checkout", "-q", "spike");
    mkdirSync(join(dir, "docs", "research"), { recursive: true });
    writeFileSync(join(dir, "docs", "research", "x.md"), "# report\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "docs");
    git(dir, "rebase", "-q", "main");
    const paths = changedPathsFor(dir, "spike", base);
    expect(paths).toEqual(["docs/research/x.md"]);
    expect(spikeCommitRefusal({ ticket_ref: "OB-9", branch: "spike", worktree: dir }, paths)).toBeNull();
  });
});

describe("ob close on a spike (OB-1826)", () => {
  test("retires the row `failed` with a `spike:` error, never `merged`, and says so", async () => {
    const s = await seedTickets();
    const { rowId } = await seedSpikeRow(s);
    fakeGit();
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(s.dbPath, ["close", s.spike, "--note", "cache key is per repo; see the notes on the parent"]);
    expect(res.code).toBe(0);
    const row = rowOf(s.dbPath, rowId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("spike: cache key is per repo; see the notes on the parent");
    expect(res.out).not.toContain("marked landed");
    expect(res.out).toContain("spike closed");

    // The builder's thread is told the spike closed (never that it landed) and is settled.
    expect(fake.sends.map((m) => m.threadId)).toEqual(["builder-thread-1"]);
    expect(fake.sends[0]!.message).toContain("spike");
    expect(fake.sends[0]!.message).not.toContain("landed");
    expect(fake.settled).toEqual(["builder-thread-1"]);
  });

  test("a reconcile that sees the closed (done) spike retires it as a spike end, never `merged`", async () => {
    const s = await seedTickets();
    const { rowId } = await seedSpikeRow(s);
    fakeGit();
    restores.push(__setT3Seam(fakeSeam().seam));
    const db = openDb(s.dbPath);
    db.query("UPDATE item SET status = 'done' WHERE id = ?").run(s.spike);
    db.close();

    await runCli(s.dbPath, ["spinoff", "reconcile"]);
    const row = rowOf(s.dbPath, rowId);
    expect(row.status).toBe("failed");
    expect(row.error?.startsWith("spike:")).toBe(true);
  });

  test("ob spinoff mix does not count the closed spike", async () => {
    const s = await seedTickets();
    const { rowId } = await seedSpikeRow(s);
    fakeGit();
    restores.push(__setT3Seam(fakeSeam().seam));
    await runCli(s.dbPath, ["close", s.spike, "--note", "answered"]);
    expect(rowOf(s.dbPath, rowId).status).toBe("failed");

    const mix = JSON.parse((await runCli(s.dbPath, ["spinoff", "mix", "--json"])).out);
    expect(mix.total).toBe(0);
    expect(JSON.stringify(mix)).toContain("closed spike");
  });

  test("buildMix drops a spike end beside a landed row", () => {
    const base = { ticket_ref: "x", repo: "r", request_at: "2026-11-06T00:00:00Z", item_id: null, tier: "medium", model: "m" } as const;
    const rows: MixSource[] = [
      { ...base, id: 1, status: "merged", error: null },
      { ...base, id: 2, status: "failed", error: "spike: answered" },
      { ...base, id: 3, status: "failed", error: "launch blew up" },
    ];
    const mix = buildMix(rows, new Map(), null);
    expect(mix.total).toBe(2);
  });

  test("an ordinary ticket's close still lands its row", async () => {
    const s = await seedTickets({ tag: "feature" });
    const { rowId } = await seedSpikeRow(s);
    fakeGit();
    restores.push(__setT3Seam(fakeSeam().seam));
    const res = await runCli(s.dbPath, ["close", s.spike]);
    expect(res.code).toBe(0);
    expect(rowOf(s.dbPath, rowId).status).toBe("merged");
    expect(res.out).toContain("marked landed");
  });
});

describe("the notes and the split (OB-1826)", () => {
  test("a closed spike's row is settled with the close, not retired like an abandoned one", () => {
    const rows = [
      { worktree: "/wt/a", status: "failed", error: "spike: answered" },
      { worktree: "/wt/b", status: "failed", error: "abandoned: oops" },
      { worktree: "/wt/c", status: "failed", error: "launch blew up" },
    ];
    const split = splitOwnRows(rows, "/wt/none");
    expect(split.retired.map((r) => r.worktree)).toEqual(["/wt/b", "/wt/c"]);
  });

  test("the spike notes say what the architect does next and never claim a landing", () => {
    const answered = spikeAnsweredNote({ ticket: "OB-9", branch: "ob-9", worktree: "/wt/ob-9", rowId: 4, composedAt: "2026-11-06T00:00:00Z" });
    expect(answered).toContain("ob close OB-9");
    expect(answered).toContain("git worktree remove --force /wt/ob-9");
    expect(answered).toContain("git branch -D ob-9");
    expect(spikeClosedNote({ ticket: "OB-9" })).not.toContain("landed:");
    // `ob close` withdraws a queued spike note for that ticket, and only that ticket's (1205).
    expect(isReadyingNoteFor(answered, "OB-9")).toBe(true);
    expect(isReadyingNoteFor(answered, "OB-90")).toBe(false);
  });
});


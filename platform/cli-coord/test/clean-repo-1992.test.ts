// OB-1992: no ob in another repo's PR. A CLEAN repo (every repo but omnislash) gets a title-slug branch, no
// ref in its subjects, the verdict on the spinoff row instead of in git, and a handoff and land guard that
// refuse a PR carrying ob. omnislash keeps its own flow. Every test here runs on injected seams: no network,
// no GitHub, no live DB.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCleanRepoDir, fakeRepoDir, freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { readyingNote, type ReadyNoteFacts } from "../../../apps/cli/src/t3/dispatch.ts";
import { landedIn, type MergedBranch, type RepoState } from "../../../apps/cli/src/tracker-link.ts";
import { renderLanded } from "../../../apps/cli/src/commands/issue.ts";
import {
  BRANCH_SLUG_MAX,
  branchSlug,
  builderIdOf,
  cleanRepoLaunchLine,
  isObRepo,
  obLeaks,
  parseRecordableVerdict,
  rowStateText,
  uniqueBranch,
  verdictStateFor,
} from "../src/clean-repo.ts";
import {
  __setSh,
  cleanBranchFor,
  enqueueSpinoff,
  listSpinoffs,
  recordSpinoffVerdict,
  rowVerdictState,
  spinoffAskFor,
  worktreeKeyOf,
} from "../src/commands/spinoff.ts";
import { checkLand, parseArgs } from "../src/land-guard.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  restores.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- 1: which repo is ob's own ------------------------------------------------------------------------------

describe("isObRepo: only omnislash is ob's own (OB-1992, design 1)", () => {
  test("omnislash in every spelling a caller holds", () => {
    for (const r of ["omnislash", "owner/omnislash", "/home/x/dev/omnislash", "/home/x/dev/omnislash/", "/home/x/dev/omnislash.ob-12", "git@github.com:x/omnislash.git", "https://github.com/x/omnislash.git", "OMNISLASH"]) {
      expect(isObRepo(r)).toBe(true);
    }
  });

  test("every other repo is clean, a look-alike name included", () => {
    for (const r of ["hackcove", "x/pixelslash", "/home/x/dev/hackcove.ps-12", "git@github.com:x/omnislash-site.git", "/tmp/omnislash-fake-repo", "", null, undefined]) {
      expect(isObRepo(r)).toBe(false);
    }
  });
});

// --- 2: the branch ----------------------------------------------------------------------------------------

describe("a clean repo's branch is a slug of the ticket title (design 2)", () => {
  test("lowercase words, at most 40 characters, cut at a word boundary; refs and ob's own words dropped", () => {
    expect(branchSlug("Add a dark theme to the Storybook")).toBe("add-a-dark-theme-to-the-storybook");
    expect(branchSlug("PS-12: spinoff the ob architect sync for omnislash")).toBe("the-sync-for");
    const long = branchSlug("Make the timeline editor keep its zoom level across reloads and tabs");
    expect(long.length).toBeLessThanOrEqual(BRANCH_SLUG_MAX);
    expect(long).toBe("make-the-timeline-editor-keep-its-zoom");
    expect(branchSlug("")).toBe("change");
  });

  test("a taken name gets -2, -3, still within 40 characters", () => {
    const taken = new Set(["fix-zoom", "fix-zoom-2"]);
    expect(uniqueBranch("fix-zoom", (n) => taken.has(n))).toBe("fix-zoom-3");
    const base = "a".repeat(40);
    const name = uniqueBranch(base, (n) => n === base);
    expect(name).toBe(`${"a".repeat(38)}-2`);
    expect(name.length).toBe(BRANCH_SLUG_MAX);
  });

  test("cleanBranchFor: a first dispatch takes the slug, the taken check sees each candidate, a re-dispatch reuses its branch", async () => {
    const asked: string[] = [];
    const first = await cleanBranchFor([], "/r/hackcove", "HC-7", async () => "Keep zoom on reload", (n) => {
      asked.push(n);
      return n === "keep-zoom-on-reload";
    });
    expect(first).toBe("keep-zoom-on-reload-2");
    expect(asked).toEqual(["keep-zoom-on-reload", "keep-zoom-on-reload-2"]);
    const again = await cleanBranchFor([{ repo: "/r/hackcove", ticket_ref: "HC-7", branch: first }], "/r/hackcove", "HC-7", async () => "renamed", () => false);
    expect(again).toBe(first);
  });

  test("the row, worktree and builder id keep the ref in a clean repo; omnislash keys them by its ref branch as always", () => {
    const clean = { repo: "/r/hackcove", branch: "keep-zoom-on-reload", ticket_ref: "HC-7" };
    expect(worktreeKeyOf(clean)).toBe("hc-7");
    expect(builderIdOf(clean)).toBe("hc-7");
    const ob = { repo: "/r/omnislash", branch: "ob-1992", ticket_ref: "OB-1992" };
    expect(worktreeKeyOf(ob)).toBe("ob-1992");
    expect(builderIdOf(ob)).toBe("ob-1992");
    expect(builderIdOf({ ...clean, agent_id: "custom" })).toBe("custom");
    // a bare issue ref keys as issue-<n>, never a leading dash
    expect(builderIdOf({ ...clean, ticket_ref: "#136" })).toBe("issue-136");
  });

  test("ob spinoff brief in a clean repo prints the title slug; --branch still overrides; omnislash prints the ref", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    const itemId = await createItem(db, { type: "task", title: "Keep the zoom level on reload" });
    db.close();
    restores.push(__setSh(() => ({ ok: false, err: "", out: "" }))); // no branch is taken, locally or on origin
    const clean = fakeCleanRepoDir("hackcove");
    const slug = JSON.parse((await runCli(dbPath, ["spinoff", "brief", itemId, "--repo", clean, "--json"])).out);
    expect(slug.branch).toBe("keep-the-zoom-level-on-reload");
    const named = JSON.parse((await runCli(dbPath, ["spinoff", "brief", itemId, "--repo", clean, "--branch", "mine", "--json"])).out);
    expect(named.branch).toBe("mine");
    const ob = JSON.parse((await runCli(dbPath, ["spinoff", "brief", itemId, "--repo", fakeRepoDir(), "--json"])).out);
    expect(ob.branch).toBe(`ob-${itemId}`);
  });
});

// --- 3: the verdict on the row -----------------------------------------------------------------------------

describe("the verdict lives on a clean repo's row (design 3)", () => {
  test("rowStateText renders the recorded verdict as the State paragraph every reader parses", () => {
    expect(rowStateText({ repo: "/r/hackcove" })).toBeNull();
    expect(rowStateText({ repo: "/r/hackcove", verdict: "landable" })).toBe("State: landable");
    expect(rowStateText({ repo: "/r/hackcove", verdict: "needs-human", verdict_reason: " is the\nwording right? ", gate_line: "green" })).toBe(
      "State: needs-human - is the wording right?\nGate: green",
    );
  });

  test("parseRecordableVerdict takes the four words and refuses anything else by name", () => {
    expect(parseRecordableVerdict("Landable")).toBe("landable");
    for (const w of ["needs-human", "blocked", "partial"]) expect(parseRecordableVerdict(w)).toBe(w);
    expect(() => parseRecordableVerdict("ready")).toThrow("landable, needs-human, blocked, partial");
    expect(() => parseRecordableVerdict("done")).toThrow("'done' is not a verdict");
  });

  test("verdictStateFor: a clean repo's recorded verdict wins; none recorded falls back to git; omnislash always reads git", () => {
    const git = () => "State: partial - from git";
    expect(verdictStateFor({ repo: "/r/hackcove", verdict: "landable" }, git)).toBe("State: landable");
    expect(verdictStateFor({ repo: "/r/hackcove" }, git)).toBe("State: partial - from git");
    expect(verdictStateFor({ repo: "/r/omnislash", verdict: "landable" }, git)).toBe("State: partial - from git");
  });

  test("rowVerdictState reads git only when the row recorded nothing", () => {
    let reads = 0;
    restores.push(
      __setSh(() => {
        reads++;
        return { ok: true, err: "", out: "fix(x): y\n\nState: blocked - from git\n" };
      }),
    );
    const base = { repo: "/r/hackcove", worktree: "/wt/x", branch: "x" };
    expect(rowVerdictState({ ...base, verdict: "landable", gate_line: "green" })).toBe("State: landable\nGate: green");
    expect(reads).toBe(0);
    expect(rowVerdictState(base)).toContain("State: blocked - from git");
  });

  test("recordSpinoffVerdict stores the three columns, refuses omnislash and a bad word", async () => {
    const db = freshDb();
    const { row } = await enqueueSpinoff(db, { ticketRef: "HC-7", repo: "/r/hackcove", branch: "keep-zoom", mode: "interactive", brief: "b" });
    const saved = await recordSpinoffVerdict(db, row, { verdict: "needs-human", reason: "is the label right?", gate: "green (test 12)" });
    expect([saved.verdict, saved.verdict_reason, saved.gate_line]).toEqual(["needs-human", "is the label right?", "green (test 12)"]);
    expect(rowVerdictState(saved)).toBe("State: needs-human - is the label right?\nGate: green (test 12)");
    await expect(recordSpinoffVerdict(db, row, { verdict: "nope" })).rejects.toThrow("is not a verdict");
    const ob = (await enqueueSpinoff(db, { ticketRef: "OB-5", repo: "/r/omnislash", branch: "ob-5", mode: "interactive", brief: "b" })).row;
    await expect(recordSpinoffVerdict(db, ob, { verdict: "landable" })).rejects.toThrow("is the State: line in the commit");
  });

  test("ob spinoff state records it, and show prints it back", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    await enqueueSpinoff(db, { ticketRef: "HC-7", repo: "/r/hackcove", branch: "keep-zoom", mode: "interactive", brief: "b" });
    db.close();
    const r = await runCli(dbPath, ["spinoff", "state", "HC-7", "landable", "--reason", "all green", "--gate", "green (test 12)"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("recorded HC-7");
    const rows = await listSpinoffs(openDb(dbPath));
    expect(rows[0]!.verdict).toBe("landable");
    expect(rows[0]!.gate_line).toBe("green (test 12)");
    const bad = await runCli(dbPath, ["spinoff", "state", "HC-7", "shipped"]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("is not a verdict");
  });

  test("the readying note names the recorded state as the verdict for a clean repo, and not for omnislash", () => {
    const facts: ReadyNoteFacts = {
      ticket: "HC-7",
      branch: "keep-zoom",
      worktree: "/wt/hc-7",
      commitsAhead: 1,
      state: "State: landable",
      builderNote: null,
      rowId: 3,
      status: "ready-for-gate",
      composedAt: "2026-11-12T10:00:00.000Z",
    };
    expect(readyingNote({ ...facts, repo: "/r/hackcove" })).toContain("The recorded state is the verdict");
    expect(readyingNote({ ...facts, repo: "/r/omnislash" })).not.toContain("The recorded state is the verdict");
  });
});

// --- 4 and 6: the handoff -----------------------------------------------------------------------------------

/** A launched clean-repo row on a tracker item, in a real empty worktree. */
async function seedCleanHandoff(dbPath: string): Promise<{ itemId: string; wt: string }> {
  const wt = tempDir("ob-wt-1992-");
  const db = openDb(dbPath, { create: true });
  const itemId = await createItem(db, { type: "task", title: "Keep zoom on reload" });
  const { row } = await enqueueSpinoff(db, { ticketRef: itemId, repo: "/r/hackcove", branch: "keep-zoom-on-reload", mode: "interactive", brief: "b", worktree: wt });
  db.query("UPDATE spinoff SET status = 'launched', worktree = ?, item_id = ? WHERE id = ?").run(wt, itemId, row.id);
  db.close();
  return { itemId, wt };
}

/** git and gh over the `sh` seam: a clean worktree, the given commit messages and PR. */
function fakeGitGh(commits: string, pr: { title: string; body: string } | null): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("--porcelain")) return { ok: true, err: "", out: "" };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: "1\n" };
      if (cmd[0] === "gh" && cmd[2] === "list") return { ok: true, err: "", out: "[]" }; // OB-2044: no open PR, so no CI to read
      if (cmd[0] === "gh") return pr ? { ok: true, err: "", out: JSON.stringify(pr) } : { ok: false, err: "no pull requests found", out: "" };
      if (line.includes("log --format=%B")) return { ok: true, err: "", out: commits };
      return { ok: true, err: "", out: "" };
    }),
  );
}

describe("ob spinoff handoff in a clean repo (designs 4 and 6)", () => {
  test("a commit, PR title or PR body carrying ob is refused, naming each hit, and nothing is stamped", async () => {
    const dbPath = freshDbPath();
    await seedCleanHandoff(dbPath);
    fakeGitGh("fix(OB-7): keep zoom\n\nState: landable\n", { title: "fix(engine): keep zoom", body: "Built by the architect's spinoff.\n\nGate: green" });
    const r = await runCli(dbPath, ["spinoff", "handoff", "keep-zoom-on-reload"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("Nothing was handed off");
    expect(r.err).toContain("commits: ref 'OB-7'");
    expect(r.err).toContain("commits: state-line 'State:'");
    expect(r.err).toContain("PR body: word 'architect'");
    expect(r.err).toContain("PR body: word 'spinoff'");
    expect(r.err).toContain("PR body: state-line 'Gate:'");
    expect(r.err).not.toContain("PR title:");
    expect((await listSpinoffs(openDb(dbPath)))[0]!.status).toBe("launched");
  });

  test("a clean PR hands off, and --report puts the Done check and review on the ticket's Decisions trail", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedCleanHandoff(dbPath);
    fakeGitGh("fix(engine): keep zoom on reload\n\nThe zoom level was reset on every reload.\n", {
      title: "fix(engine): keep zoom on reload",
      body: "The zoom level was reset on every reload. It is now kept.\n\nTested with bun test (12 pass).",
    });
    const report = join(tempDir("ob-report-1992-"), "report.md");
    writeFileSync(report, "## Done check\n- zoom kept: pass (test zoom.test.ts)\n\n## Skeptical review\n0 cut, 0 open\n");
    const r = await runCli(dbPath, ["spinoff", "handoff", itemId, "--note", "zoom kept", "--report", report]);
    expect(r.code).toBe(0);
    const notes = (await decisionsForItem(openDb(dbPath), itemId)).map((d) => d.note ?? "");
    const joined = notes.join("\n");
    expect(joined).toContain("zoom kept");
    expect(joined).toContain("## Done check");
    expect(joined).toContain("## Skeptical review");
  });

  test("--report naming a missing file is a usage error before anything is stamped", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedCleanHandoff(dbPath);
    fakeGitGh("fix(engine): x\n", null);
    const r = await runCli(dbPath, ["spinoff", "handoff", itemId, "--report", "/nowhere/report.md"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--report: no such file");
    expect((await listSpinoffs(openDb(dbPath)))[0]!.status).toBe("launched");
  });

  test("a branch that carries the ref is refused too", async () => {
    const dbPath = freshDbPath();
    const wt = tempDir("ob-wt-1992-");
    const db = openDb(dbPath, { create: true });
    const { row } = await enqueueSpinoff(db, { ticketRef: "HC-7", repo: "/r/hackcove", branch: "hc-7-keep-zoom", mode: "interactive", brief: "b", worktree: wt });
    db.query("UPDATE spinoff SET status = 'launched', worktree = ? WHERE id = ?").run(wt, row.id);
    db.close();
    fakeGitGh("fix(engine): keep zoom\n", null);
    const r = await runCli(dbPath, ["spinoff", "handoff", "HC-7"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("branch hc-7-keep-zoom: ref 'hc-7'");
  });
});

// --- 6: the leak check itself and the land guard ------------------------------------------------------------

describe("obLeaks (design 6)", () => {
  test("flags a ref, a State/Gate/Visual line, ob and its commands, architect, spinoff, omnislash, AGENTS.md", () => {
    const text = "fix(PS-12): x\n\nState: landable\nGate: green\n> Visual: ok\nRun ob spinoff show, ask the architect, see AGENTS.md in omnislash. ob";
    const kinds = obLeaks(text).map((l) => `${l.kind}:${l.match}`);
    expect(kinds).toEqual(
      expect.arrayContaining(["ref:PS-12", "state-line:State:", "state-line:Gate:", "state-line:Visual:", "ob-command:ob spinoff", "word:architect", "word:AGENTS.md", "word:omnislash", "word:ob"]),
    );
  });

  test("a plain open-source PR body has none, standards and paths included", () => {
    const body = "The zoom level reset on reload. It is now kept in UTF-8 local storage, hashed with SHA-256.\n\nTested: bun test (12 pass), see docs/ob/notes.md and the job blob.";
    expect(obLeaks(body)).toEqual([]);
  });

  test("with project keys, only those keys are refs", () => {
    expect(obLeaks("see ABC-12 and PS-3", ["PS"]).map((l) => l.match)).toEqual(["PS-3"]);
  });
});

function gitRepo(origin: string | null): string {
  const dir = tempDir("ob-guard-1992-");
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  };
  run("init", "-q", "-b", "main");
  if (origin) run("remote", "add", "origin", origin);
  writeFileSync(join(dir, "a.txt"), "1\n");
  run("add", "-A");
  run("commit", "-q", "-m", "feat(engine): a");
  writeFileSync(join(dir, "b.txt"), "1\n");
  run("add", "-A");
  run("commit", "-q", "-m", "feat(engine): b\n\nState: landable");
  return dir;
}

describe("the land guard refuses ob in a clean repo's squash (design 5 and 6)", () => {
  test("a clean origin: the subject and the squash body are both checked", () => {
    const repo = gitRepo("git@github.com:x/hackcove.git");
    const bad = checkLand({ repo, head: "HEAD", against: "HEAD~1", subject: "feat(HC-7): b", body: "Built by a spinoff." });
    expect(bad.clean).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.leaks.map((l) => l.where)).toEqual(["subject", "body"]);
    const good = checkLand({ repo, head: "HEAD", against: "HEAD~1", subject: "feat(engine): b", body: "Adds b." });
    expect(good.ok).toBe(true);
  });

  test("with no --body the head commit's own body is read, so a State line there is refused", () => {
    const repo = gitRepo("git@github.com:x/hackcove.git");
    const r = checkLand({ repo, head: "HEAD", against: "HEAD~1", subject: "feat(engine): b" });
    expect(r.leaks).toEqual([{ where: "body", leaks: [{ kind: "state-line", match: "State:" }] }]);
  });

  test("omnislash is not checked: its subjects carry the ref by design", () => {
    const repo = gitRepo("git@github.com:x/omnislash.git");
    const r = checkLand({ repo, head: "HEAD", against: "HEAD~1", subject: "feat(OB-1992): b" });
    expect(r.clean).toBe(false);
    expect(r.ok).toBe(true);
  });

  test("parseArgs reads --body-file, --keys and --clean", () => {
    const file = join(tempDir("ob-guard-args-"), "body.md");
    writeFileSync(file, "the squash body\n");
    const a = parseArgs(["--repo", "/r", "--head", "h", "--against", "a", "--body-file", file, "--keys", "PS,HC", "--clean"]);
    expect(a.body).toBe("the squash body\n");
    expect(a.keys).toEqual(["PS", "HC"]);
    expect(a.clean).toBe(true);
  });
});

// --- 7: ob issue landed ---------------------------------------------------------------------------------

describe("ob issue landed in a clean repo (design 7)", () => {
  const branch = (over: Partial<MergedBranch> & { name: string }): MergedBranch => ({ tip: "tip", ownCommits: true, proof: "base-sha", mention: null, ...over });
  const state = (over: Partial<RepoState> = {}): RepoState => ({
    checkout: "/r/hackcove",
    main: "main",
    readable: true,
    readError: null,
    commits: [],
    branches: [],
    spinoffs: [],
    unlinkedObItems: new Set<number>(),
    ...over,
  });

  test("a merged title-slug branch counts when the row recorded it for this ref, and the report says clean", () => {
    const s = state({ branches: [branch({ name: "keep-zoom-on-reload", mention: { namespace: "ref", key: "HC", number: 7 } })] });
    const r = landedIn(s, [{ namespace: "ref", key: "HC", number: 7, via: "asked" }]);
    expect(r.fired).toEqual(["merged-branch"]);
    expect(r.clean).toBe(true);
    expect(renderLanded(r, "HC-7", false)).toContain("clean repo: subjects carry no ref");
    const other = landedIn(s, [{ namespace: "ref", key: "HC", number: 8, via: "asked" }]);
    expect(other.fired).toEqual([]);
  });

  test("omnislash reports no clean line", () => {
    const r = landedIn(state({ checkout: "/r/omnislash" }), [{ namespace: "ob", number: 1, via: "asked" }]);
    expect(r.clean).toBeUndefined();
    expect(renderLanded(r, "1", false)).not.toContain("clean repo");
  });
});

// --- 8: the launch prompt one-liner ------------------------------------------------------------------------

describe("the launch prompt carries the one-line rule in a clean repo only (design 8)", () => {
  test("a clean repo's brief ends with the rule and the builder id; omnislash's does not", async () => {
    const clean = await spinoffAskFor(null, "/nowhere/hackcove", "HC-7", { brief: "do it" });
    expect(clean).toContain(cleanRepoLaunchLine("HC-7"));
    expect(clean).toContain("ob spinoff state HC-7");
    expect(clean).toContain("Your builder id is `hc-7`");
    expect(await spinoffAskFor(null, "/nowhere/omnislash", "OB-7", { brief: "do it" })).toBe("do it");
  });
});

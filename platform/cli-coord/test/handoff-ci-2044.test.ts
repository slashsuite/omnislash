// OB-2044: a builder hands off only once its PR's CI passes. Every test runs on an injected `sh` seam with a
// fake `gh`: no network, no GitHub, no live DB. The guard itself is driven with fixtures for each rollup shape;
// the local command (`ob spinoff handoff` through runCli) is driven end to end. The API client path is driven
// in platform/cli-core/test/api-spinoff-360.test.ts, where its stubbed transport lives.
import { liveRead, openRunsOnSeats } from "../../../apps/cli/test/role-run-fixture.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli, omnislashTeamFor } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { addTags, createItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { __setT3Seam, readyingNote, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import type { T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import { registerAgent } from "../src/agent.ts";
import { __setSh, enqueueSpinoff, gateNoteWithCi, listSpinoffs } from "../src/commands/spinoff.ts";
import { COULD_NOT_READ_CI, assertHandoffCi, ciLine, normaliseCheck, repoRunsCiOnPullRequests, type HandoffCiInput } from "../src/commands/handoff-ci.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  restores.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

/** GitHub's check run shape, as `gh pr list --json statusCheckRollup` prints it. */
const run = (name: string, status: string, conclusion: string, detailsUrl = `https://github.com/o/r/actions/runs/${name}`) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl,
});
const green = (name: string) => run(name, "COMPLETED", "SUCCESS");

type Pr = { number: number; url: string; headRefOid: string; statusCheckRollup: unknown[] };
const pr = (checks: unknown[], headRefOid = HEAD): Pr => ({ number: 431, url: "https://github.com/o/r/pull/431", headRefOid, statusCheckRollup: checks });

type Gh = { ok: true; prs: Pr[] } | { ok: false; err: string };
function guard(gh: Gh, over: Partial<HandoffCiInput> = {}, worktree = tempDir("ob-wt-2044-")) {
  const calls: string[][] = [];
  const input: HandoffCiInput = {
    worktree,
    branch: "ob-2044",
    headSha: HEAD,
    sh: (cmd) => {
      calls.push(cmd);
      return gh.ok ? { ok: true, err: "", out: JSON.stringify(gh.prs) } : { ok: false, err: gh.err, out: "" };
    },
    ...over,
  };
  return { calls, run: () => assertHandoffCi(input, (m) => new Error(m)) };
}

function workflowOnPullRequest(worktree: string): void {
  mkdirSync(join(worktree, ".github", "workflows"), { recursive: true });
  writeFileSync(join(worktree, ".github", "workflows", "ci.yml"), "name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\njobs: {}\n");
}

describe("assertHandoffCi: the guard (OB-2044)", () => {
  test("a green PR passes and names the checks and the head sha", () => {
    const g = guard({ ok: true, prs: [pr([green("gate"), green("ui-review")])] });
    expect(g.run()).toEqual({ kind: "checked", line: "ci: gate pass, ui-review pass on aaaaaaa" });
    // The PR is looked up by the branch's OPEN PR (a closed or merged one never counts).
    expect(g.calls[0]).toEqual(["gh", "pr", "list", "--head", "ob-2044", "--state", "open", "--json", "number,url,headRefOid,statusCheckRollup"]);
  });

  test("skipped and neutral count as passing, and the line says so", () => {
    const g = guard({ ok: true, prs: [pr([green("gate"), run("ui-review", "COMPLETED", "SKIPPED"), run("lint", "COMPLETED", "NEUTRAL")])] });
    expect(g.run().line).toBe("ci: gate pass, ui-review skipped, lint neutral on aaaaaaa");
  });

  test("a failing check is refused, named with its link; every other non-pass conclusion fails too", () => {
    for (const conclusion of ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
      const g = guard({ ok: true, prs: [pr([green("ui-review"), run("gate", "COMPLETED", conclusion, "https://github.com/o/r/actions/runs/9")])] });
      expect(() => g.run()).toThrow(/CI is failing on PR #431 \(aaaaaaa\)\. Nothing was handed off:\n {2}gate: .+ https:\/\/github\.com\/o\/r\/actions\/runs\/9/);
      // Only the failing check is named, never the one that passed.
      expect(() => g.run()).toThrow(/^(?![\s\S]*ui-review)/);
    }
  });

  test("a failing commit status (the other rollup shape) is refused too", () => {
    const g = guard({ ok: true, prs: [pr([{ __typename: "StatusContext", context: "ci/legacy", state: "FAILURE", targetUrl: "https://ci.example/1" }])] });
    expect(() => g.run()).toThrow("ci/legacy: failure https://ci.example/1");
  });

  test("a pending check is refused, naming it and the wait command", () => {
    for (const status of ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING"]) {
      const g = guard({ ok: true, prs: [pr([green("ui-review"), run("gate", status, "")])] });
      expect(() => g.run()).toThrow("CI still running on aaaaaaa: gate. Wait with `gh pr checks 431 --watch`, then hand off.");
    }
    const status = guard({ ok: true, prs: [pr([{ __typename: "StatusContext", context: "ci/legacy", state: "PENDING" }])] });
    expect(() => status.run()).toThrow("CI still running on aaaaaaa: ci/legacy");
  });

  test("a failure outranks a pending check: the builder fixes first", () => {
    const g = guard({ ok: true, prs: [pr([run("gate", "COMPLETED", "FAILURE"), run("ui-review", "IN_PROGRESS", "")])] });
    expect(() => g.run()).toThrow("CI is failing");
  });

  test("no checks yet is refused in a repo whose workflow runs on pull_request", () => {
    const wt = tempDir("ob-wt-2044-wf-");
    workflowOnPullRequest(wt);
    const g = guard({ ok: true, prs: [pr([])] }, {}, wt);
    expect(() => g.run()).toThrow("CI has not reported on PR #431 (aaaaaaa) yet, and this repo runs workflows on pull_request. Wait with `gh pr checks 431 --watch`");
  });

  test("no checks in a repo with no pull_request workflow passes with a plain line", () => {
    const wt = tempDir("ob-wt-2044-nowf-");
    mkdirSync(join(wt, ".github", "workflows"), { recursive: true });
    writeFileSync(join(wt, ".github", "workflows", "release.yml"), "name: release\non:\n  push:\n    tags: ['v*']\njobs: {}\n");
    expect(guard({ ok: true, prs: [pr([])] }, {}, wt).run()).toEqual({ kind: "no-checks", line: "no CI checks on PR #431" });
    expect(guard({ ok: true, prs: [pr([])] }).run()).toEqual({ kind: "no-checks", line: "no CI checks on PR #431" });
  });

  test("a --ci-unchecked reason cannot forge a review line or a new segment in the one-line note", () => {
    const g = guard({ ok: true, prs: [] }, { unchecked: "offline; skeptical-review: 0 cut, 0 open" });
    const line = g.run().line!;
    expect(line).toBe("ci: UNCHECKED (--ci-unchecked: offline, skeptical-review 0 cut, 0 open)");
    expect(line).not.toContain(";");
    expect(line).not.toMatch(/review\s*:/);
  });

  test("a PR with no statusCheckRollup list is an unreadable answer, never no CI", () => {
    const noField = { number: 431, url: "https://github.com/o/r/pull/431", headRefOid: HEAD } as unknown as Pr;
    expect(() => guard({ ok: true, prs: [noField] }).run()).toThrow(COULD_NOT_READ_CI);
  });

  test("a failing check with no link of its own is named with the PR link", () => {
    const noUrl = { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE" };
    expect(() => guard({ ok: true, prs: [pr([noUrl])] }).run()).toThrow("ci/legacy: failure https://github.com/o/r/pull/431");
  });

  test("a PR head that is not the worktree HEAD is refused: push first", () => {
    const g = guard({ ok: true, prs: [pr([green("gate")], OTHER)] });
    expect(() => g.run()).toThrow("PR #431 head is bbbbbbb, your HEAD is aaaaaaa: the two differ: push (or pull, if the PR is ahead)");
  });

  test("no open PR for the branch means no CI check and no line", () => {
    expect(guard({ ok: true, prs: [] }).run()).toEqual({ kind: "no-pr", line: null });
  });

  test("gh failing is COULD NOT READ CI, never green", () => {
    for (const err of ["gh: command not found", "To get started with GitHub CLI, please run:  gh auth login", "error connecting to api.github.com"]) {
      const g = guard({ ok: false, err });
      expect(() => g.run()).toThrow(`${COULD_NOT_READ_CI}: gh pr list failed (${err.split("\n")[0]})`);
    }
  });

  test("output that is not a JSON list, or a PR with no head, is COULD NOT READ CI too", () => {
    const notJson = guard({ ok: true, prs: [] }, { sh: () => ({ ok: true, err: "", out: "State: ready" }) });
    expect(() => notJson.run()).toThrow(COULD_NOT_READ_CI);
    const empty = guard({ ok: true, prs: [] }, { sh: () => ({ ok: true, err: "", out: "" }) });
    expect(() => empty.run()).toThrow(COULD_NOT_READ_CI);
    for (const out of ["[null]", "[5]", '["x"]', "[[]]"]) {
      const entry = guard({ ok: true, prs: [] }, { sh: () => ({ ok: true, err: "", out }) });
      expect(() => entry.run()).toThrow(`${COULD_NOT_READ_CI}: gh pr list printed something that is not a JSON list of PRs`);
    }
    const noHead = guard({ ok: true, prs: [{ number: 5, url: "u", headRefOid: "", statusCheckRollup: [green("gate")] }] });
    expect(() => noHead.run()).toThrow(`${COULD_NOT_READ_CI}: PR #5 reported no head commit`);
    const noGitHead = guard({ ok: true, prs: [pr([green("gate")])] }, { headSha: null });
    expect(() => noGitHead.run()).toThrow(`${COULD_NOT_READ_CI}: git could not read the HEAD of ob-2044`);
  });

  test("a checkout gh cannot read (no GitHub remote, not a git repository) is COULD NOT READ CI: only a successful empty list means no PR", () => {
    for (const err of ["no git remotes found", "none of the git remotes configured for this repository point to a known GitHub host", "fatal: not a git repository (or any of the parent directories): .git"]) {
      expect(() => guard({ ok: false, err }).run()).toThrow(COULD_NOT_READ_CI);
    }
  });

  test("every open PR for the branch name must pass, not just the first", () => {
    const g = guard({ ok: true, prs: [pr([green("gate")]), { ...pr([run("gate", "IN_PROGRESS", "")]), number: 432 }] });
    expect(() => g.run()).toThrow("CI still running on aaaaaaa: gate");
  });

  test("several green PRs are all named on the line", () => {
    const g = guard({ ok: true, prs: [pr([green("gate")]), { ...pr([green("ui-review")]), number: 432 }] });
    expect(g.run().line).toBe("ci: gate pass on aaaaaaa; ci: ui-review pass on aaaaaaa");
  });

  test("workflows that cannot be read are an unknown, not 'no CI': refused with COULD NOT READ CI", () => {
    const wt = tempDir("ob-wt-2044-");
    mkdirSync(join(wt, ".github"), { recursive: true });
    writeFileSync(join(wt, ".github", "workflows"), "a file where the directory should be");
    expect(() => guard({ ok: true, prs: [pr([])] }, {}, wt).run()).toThrow(`${COULD_NOT_READ_CI}: the workflows under .github/workflows could not be read`);
  });

  test("only a pull_request trigger counts, filtered or not: a push-only workflow naming it, and a comment do not", () => {
    const wfs: Array<[string, boolean]> = [
      ["on:\n  pull_request:\n  push:\n", true],
      ["on: [push, pull_request]\n", true],
      ["on: pull_request\n", true],
      ["on: { pull_request: { paths: ['src/**'] } }\n", true],
      ["on:\n  pull_request:\n    branches: [main]\n", true],
      ["on:\n  pull_request:\n    types: [opened, synchronize]\n", true],
      ["on:\n  pull_request:\n    paths-ignore: ['docs/**']\n", true],
      ["name: pull_request\non:\n  push:\njobs:\n  a:\n    if: github.event_name != 'pull_request'\n", false],
    ];
    for (const [yaml, expected] of wfs) {
      const wt = tempDir("ob-wt-2044-");
      mkdirSync(join(wt, ".github", "workflows"), { recursive: true });
      writeFileSync(join(wt, ".github", "workflows", "w.yml"), yaml);
      expect(repoRunsCiOnPullRequests(wt), yaml).toBe(expected);
    }
  });

  test("a pull_request mention in a comment is not a workflow that runs on pull_request", () => {
    const wt = tempDir("ob-wt-2044-");
    mkdirSync(join(wt, ".github", "workflows"), { recursive: true });
    writeFileSync(join(wt, ".github", "workflows", "release.yml"), "# runs on pull_request in the old setup\nname: release\non:\n  push:\njobs: {}\n");
    expect(guard({ ok: true, prs: [pr([])] }, {}, wt).run()).toEqual({ kind: "no-checks", line: "no CI checks on PR #431" });
  });

  test("--ci-unchecked skips the read and carries its reason; a blank reason is refused", () => {
    const g = guard({ ok: false, err: "gh: command not found" }, { unchecked: "  gh is\n not installed on this host " });
    expect(g.run()).toEqual({ kind: "unchecked", line: "ci: UNCHECKED (--ci-unchecked: gh is not installed on this host)" });
    expect(g.calls).toEqual([]);
    expect(() => guard({ ok: true, prs: [] }, { unchecked: "   " }).run()).toThrow("--ci-unchecked needs a reason");
  });

  test("normaliseCheck reads both rollup shapes", () => {
    expect(normaliseCheck(green("gate"))).toMatchObject({ name: "gate", state: "pass", detail: "success" });
    expect(normaliseCheck(run("gate", "COMPLETED", ""))).toMatchObject({ state: "fail" });
    expect(normaliseCheck({ __typename: "StatusContext", context: "x", state: "SUCCESS" })).toMatchObject({ name: "x", state: "pass" });
    expect(normaliseCheck({ __typename: "StatusContext", context: "x", state: "ERROR" })).toMatchObject({ state: "fail" });
  });
});

// --- the local command, end to end ----------------------------------------------------------------------------

/** A launched omnislash row on a tracker item, in a real worktree directory (with a pull_request workflow). */
async function seedHandoff(dbPath: string): Promise<{ itemId: string; wt: string }> {
  const wt = tempDir("ob-wt-2044-cli-");
  workflowOnPullRequest(wt);
  const db = openDb(dbPath, { create: true });
  const itemId = await createItem(db, { type: "task", title: "Hand off on green CI" });
  const { row } = await enqueueSpinoff(db, { ticketRef: itemId, repo: "/r/omnislash", branch: "ob-2044", mode: "interactive", brief: "b", worktree: wt });
  db.query("UPDATE spinoff SET status = 'launched', worktree = ?, item_id = ?, base_sha = 'base123' WHERE id = ?").run(wt, itemId, row.id);
  db.close();
  return { itemId, wt };
}

/** git and gh over the `sh` seam: a clean worktree on `HEAD`, one State: landable commit, and the given `gh` answer. */
function fakeGitGh(gh: Gh): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (cmd[0] === "gh") return gh.ok ? { ok: true, err: "", out: JSON.stringify(gh.prs) } : { ok: false, err: gh.err, out: "" };
      if (line.includes("--porcelain")) return { ok: true, err: "", out: "" };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: "1\n" };
      if (line.includes("rev-parse --verify")) return { ok: true, err: "", out: `${HEAD}\n` };
      if (line.includes("log --format=%B")) return { ok: true, err: "", out: "feat(OB-2044): hand off on green CI\n\nState: landable\n" };
      return { ok: true, err: "", out: "" };
    }),
  );
}

const status = async (dbPath: string): Promise<string> => (await listSpinoffs(openDb(dbPath)))[0]!.status;
const trail = async (dbPath: string, itemId: string): Promise<string> => (await decisionsForItem(openDb(dbPath), itemId)).map((d) => d.note ?? "").join("\n");

describe("ob spinoff handoff reads the PR's CI (OB-2044, local path)", () => {
  test("pending, failing, no checks yet and a stale PR head all refuse, and none moves the row", async () => {
    const cases: Array<[string, Gh, string[]]> = [
      ["pending", { ok: true, prs: [pr([green("ui-review"), run("gate", "IN_PROGRESS", "")])] }, ["CI still running on aaaaaaa: gate", "gh pr checks 431 --watch", "Nothing was handed off"]],
      ["failing", { ok: true, prs: [pr([run("gate", "COMPLETED", "FAILURE", "https://github.com/o/r/actions/runs/7")])] }, ["CI is failing on PR #431", "gate: failure https://github.com/o/r/actions/runs/7"]],
      ["no checks yet", { ok: true, prs: [pr([])] }, ["CI has not reported on PR #431", "runs workflows on pull_request"]],
      ["stale head", { ok: true, prs: [pr([green("gate")], OTHER)] }, ["PR #431 head is bbbbbbb, your HEAD is aaaaaaa: the two differ: push (or pull, if the PR is ahead)"]],
    ];
    for (const [name, gh, expected] of cases) {
      const dbPath = freshDbPath();
      const { itemId } = await seedHandoff(dbPath);
      fakeGitGh(gh);
      const r = await runCli(dbPath, ["spinoff", "handoff", itemId]);
      expect(r.code, name).not.toBe(0);
      for (const text of expected) expect(r.err, name).toContain(text);
      expect(await status(dbPath), name).toBe("launched");
      restores.pop()!();
    }
  });

  test("a green PR hands off, and the trail carries the ci line with the checks and head sha", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedHandoff(dbPath);
    fakeGitGh({ ok: true, prs: [pr([green("gate"), green("ui-review")])] });
    const r = await runCli(dbPath, ["spinoff", "handoff", itemId, "--note", "landed the guard"]);
    expect(r.code).toBe(0);
    expect(await status(dbPath)).toBe("ready-for-gate");
    const t = await trail(dbPath, itemId);
    expect(t).toContain("landed the guard");
    expect(t).toContain("ci: gate pass, ui-review pass on aaaaaaa");
  });

  test("the readying note sent to the architect thread carries the ci line on its gate line (the real wiring)", async () => {
    const dbPath = freshDbPath();
    const { itemId, wt } = await seedHandoff(dbPath);
    const db = openDb(dbPath);
    db.query("UPDATE spinoff SET launcher = 't3', agent_id = 'ob-2044' WHERE item_id = ?").run(itemId);
    await registerAgent(db, { id: "ob-2044", ticket: itemId, branch: "ob-2044", worktree: wt, status: "readying", note: "moon clean; skeptical-review: 0 cut, 0 open", ttlS: 900 });
    omnislashTeamFor(db, itemId);
    await registerAgent(db, { id: "architect-omnislash", worktree: "/r/omnislash", status: "planning", launcher: "t3", sessionId: "architect-thread-1", ttlS: 900 });
    await openRunsOnSeats(db);
    db.close();
    const sends: T3SendInput[] = [];
    const unused = (name: string) => async () => {
      throw new Error(`${name} is not used by the note path`);
    };
    restores.push(
      __setT3Seam({
        interrupt: async () => {},
        projects: unused("projects"),
        capabilities: unused("capabilities"),
        list: unused("list"),
        read: liveRead,
        launch: unused("launch"),
        rename: unused("rename"),
        settle: async () => {},
        send: async (input: T3SendInput) => {
          sends.push(input);
        },
        queue: async () => ({ messages: [] }),
        pin: async () => {},
        unpin: async () => {},
        disableAutoSettle: async () => {},
        queueCancel: async () => {},
        wait: async () => ({ runId: null, status: "idle", timedOut: false }),
      } as unknown as T3Seam),
    );
    fakeGitGh({ ok: true, prs: [pr([green("gate"), green("ui-review")])] });
    const r = await runCli(dbPath, ["spinoff", "handoff", itemId]);
    expect(r.code).toBe(0);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.message).toContain("ci: gate pass, ui-review pass on aaaaaaa");
    expect(sends[0]!.message).toContain("review:    skeptical-review: 0 cut, 0 open");
  });

  test("a bad --tier-fit is a usage error before the CI read, so it does not hide behind a CI refusal", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedHandoff(dbPath);
    fakeGitGh({ ok: true, prs: [pr([run("gate", "COMPLETED", "FAILURE")])] });
    const r = await runCli(dbPath, ["spinoff", "handoff", itemId, "--tier-fit", "sideways"]);
    expect(r.code).not.toBe(0);
    expect(r.err).not.toContain("CI is failing");
    expect(r.err).toContain("tier-fit");
  });

  test("a branch with no PR hands off with no CI line", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedHandoff(dbPath);
    fakeGitGh({ ok: true, prs: [] });
    const r = await runCli(dbPath, ["spinoff", "handoff", itemId, "--note", "no pr here"]);
    expect(r.code).toBe(0);
    expect(await status(dbPath)).toBe("ready-for-gate");
    expect(await trail(dbPath, itemId)).not.toContain("ci:");
  });

  test("gh failing refuses with COULD NOT READ CI and stamps nothing", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedHandoff(dbPath);
    fakeGitGh({ ok: false, err: "gh: command not found" });
    const r = await runCli(dbPath, ["spinoff", "handoff", itemId]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("COULD NOT READ CI");
    expect(r.err).toContain("--ci-unchecked");
    expect(await status(dbPath)).toBe("launched");
  });

  test("--ci-unchecked '<why>' lets it through, with the reason on the trail", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedHandoff(dbPath);
    fakeGitGh({ ok: false, err: "gh: command not found" });
    const r = await runCli(dbPath, ["spinoff", "handoff", itemId, "--ci-unchecked", "gh is not installed on this host"]);
    expect(r.code).toBe(0);
    expect(await status(dbPath)).toBe("ready-for-gate");
    expect(await trail(dbPath, itemId)).toContain("ci: UNCHECKED (--ci-unchecked: gh is not installed on this host)");
  });

  test("the architect's --no-note stamp is guarded too, and passes with --ci-unchecked", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedHandoff(dbPath);
    fakeGitGh({ ok: true, prs: [pr([run("gate", "IN_PROGRESS", "")])] });
    const refused = await runCli(dbPath, ["spinoff", "handoff", itemId, "--no-note"]);
    expect(refused.code).not.toBe(0);
    expect(await status(dbPath)).toBe("launched");
    const through = await runCli(dbPath, ["spinoff", "handoff", itemId, "--no-note", "--ci-unchecked", "architect gates the PR head itself"]);
    expect(through.code).toBe(0);
    expect(await status(dbPath)).toBe("ready-for-gate");
    expect(await trail(dbPath, itemId)).toContain("ci: UNCHECKED (--ci-unchecked: architect gates the PR head itself)");
  });

  test("a repeat --no-note on an already handed-off row announces nothing, so it skips the CI read; a repeat that announces is guarded", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedHandoff(dbPath);
    fakeGitGh({ ok: true, prs: [] });
    expect((await runCli(dbPath, ["spinoff", "handoff", itemId, "--no-note"])).code).toBe(0);
    expect(await status(dbPath)).toBe("ready-for-gate");
    fakeGitGh({ ok: true, prs: [pr([run("gate", "COMPLETED", "FAILURE")])] });
    const quiet = await runCli(dbPath, ["spinoff", "handoff", itemId, "--no-note"]);
    expect(quiet.code).toBe(0);
    expect(quiet.err).not.toContain("CI is failing");
    const loud = await runCli(dbPath, ["spinoff", "handoff", itemId]);
    expect(loud.code).not.toBe(0);
    expect(loud.err).toContain("CI is failing");
  });

  test("a spike never reads CI (it opens no PR)", async () => {
    const dbPath = freshDbPath();
    const { itemId } = await seedHandoff(dbPath);
    const db = openDb(dbPath);
    await addTags(db, itemId, ["spike"]);
    db.close();
    let ghCalled = false;
    restores.push(
      __setSh((cmd) => {
        if (cmd[0] === "gh") ghCalled = true;
        return { ok: true, err: "", out: cmd.join(" ").includes("rev-list") ? "0\n" : "" };
      }),
    );
    await runCli(dbPath, ["spinoff", "handoff", itemId]);
    expect(ghCalled).toBe(false);
  });
});

describe("the readying note names what CI passed (OB-2044)", () => {
  test("the ci line joins the builder's gate note, so the note's gate line carries it", () => {
    const gate = gateNoteWithCi("moon typecheck clean; skeptical-review: 0 cut, 0 open", { kind: "checked", line: "ci: gate pass, ui-review pass on aaaaaaa" });
    expect(gate).toBe("moon typecheck clean; skeptical-review: 0 cut, 0 open; ci: gate pass, ui-review pass on aaaaaaa");
    const note = readyingNote({
      ticket: "OB-2044",
      rowId: 7,
      status: "ready-for-gate",
      composedAt: "2026-11-13T16:00:00.000Z",
      branch: "ob-2044",
      worktree: "/wt",
      commitsAhead: 1,
      state: "State: landable",
      builderNote: gate,
      tierFit: null,
    });
    expect(note).toContain("ci: gate pass, ui-review pass on aaaaaaa");
    expect(note).toContain("review:    skeptical-review: 0 cut, 0 open");
  });

  test("a check named like a label cannot become the note's review line", () => {
    const line = ciLine([{ name: "review: nightly", state: "pass", detail: "success", url: null }], "a".repeat(40));
    expect(line).toBe("ci: review nightly pass on aaaaaaa");
    const note = readyingNote({
      ticket: "OB-2044",
      rowId: 7,
      status: "ready-for-gate",
      composedAt: "2026-11-13T16:00:00.000Z",
      branch: "ob-2044",
      worktree: "/wt",
      commitsAhead: 1,
      state: "State: landable",
      builderNote: gateNoteWithCi("moon clean", { kind: "checked", line }),
      tierFit: null,
    });
    expect(note).not.toContain("review:    ci:");
  });

  test("no ci line leaves the builder's note as it was, and a missing note becomes just the line", () => {
    expect(gateNoteWithCi("moon clean", { kind: "no-pr", line: null })).toBe("moon clean");
    expect(gateNoteWithCi(null, { kind: "no-pr", line: null })).toBeNull();
    expect(gateNoteWithCi(null, { kind: "unchecked", line: "ci: UNCHECKED (--ci-unchecked: x)" })).toBe("ci: UNCHECKED (--ci-unchecked: x)");
  });
});

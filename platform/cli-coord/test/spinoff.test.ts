import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runCli, freshDb, freshDbPath, fakeRepoDir, psTable, spawnBudget, until } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { rulesBlock } from "../../../apps/cli/src/repo-private.ts";

/** OB-2103: a dispatch with a store appends the omnislash stage block (no stage set in a fresh store, so the beta default). */
const withStage = (brief: string): string => brief + rulesBlock("omnislash", null);
import { apiCleanupData } from "../../../apps/cli/src/api/spinoff-client.ts";
import type { ApiClient } from "../../../apps/cli/src/api/client.ts";

import {
  enqueueSpinoff,
  listSpinoffs,
  claimSpinoffRow,
  drainSpinoffs,
  stampSpinoff,
  reconcileSpinoffs,
  localSpinoffSteps,
  gitUniqueCommitCount,
  isCoordinatorAgent,
  agentRepoMap,
  liveBuildAgentsByRepo,
  worktreePath,
  spinoffTabCommand,
  withSessionID,
  composeBrief,
  selectProcedure,
  operatingProcedure,
  spinoffAsk,
  spinoffAskFor,
  ticketBrief,
  selectLauncherName,
  rowLauncherName,
  spinoffEngine,
  parseProcessTable,
  processTableSawSelf,
  processUsingPath,
  probeArgv,
  launchNotReady,
  launcherRejection,
  isLauncherName,
  isLegacyLauncherName,
  LAUNCHER_NAMES,
  DEFAULT_LAUNCHER,
  recordSpinoffSpawnFailure,
  MAX_LAUNCH_ATTEMPTS,
  ensureWorktree,
  prepareLaunchWith,
  readCommitState,
  readChangedPaths,
  commitsAheadFor,
  resolveRepo,
  repoDispatchSlug,
  rewriteSpinoffRepoArgv,
  rowRepoPath,
  pickSpinoffForShow,
  isSpinoffEnqueue,
  __setSh,
  decideCleanup,
  parseWorktreeList,
  cleanupWorktrees,
  parseMergedPrHeads,
  githubMergedPrHeads,
  __setMergedPrRead,
  type ShResult,
  renderCleanupLines,
  storeLiveRow,
  storeCleanupData,
  type CleanupData,
  landCommitFor,
  gitMergedChecker,
  watchReconcileTick,
  watchSpinoffs,
  recentlyDoneSpinoffs,
  formatDoneSpinoff,
  type SpinoffWatchState,
  type EnqueueInput,
  type SpinoffRow,
  ticketTitleFor,
  spinoffTicketTagsFor,
} from "../src/commands/spinoff.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { run } from "../../../apps/cli/src/cli.ts";
import { readFileSync, existsSync } from "node:fs";
import { registerAgent, listAgents, getAgent } from "../src/agent.ts";
import { addTags, createItem } from "../../../apps/cli/src/items.ts";
import { linkIssue, workHasLanded } from "../../../apps/cli/src/tracker-link.ts";
import { liveHold, ticketLeaseKey } from "../src/lease.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { setting, DEFAULTS } from "../../../apps/cli/src/settings.ts";
import { mkdirSync, rmSync, chmodSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// Plain code-unit order of the string form, what a bare sort() gives.
const byCodeUnit = (x: string | null, y: string | null) => (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0);

/** The monorepo root, for the cross-language pins that read the Swift side of a shared contract. */
const REPO_ROOT = join(import.meta.dir, "../../..");

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "CUE-9893",
  repo: "/r/cue-frontend",
  branch: "cue-9893-x",
  mode: "agent",
  brief: "implement the transcript",
  ...over,
});

const rowOf = (over: Partial<SpinoffRow> = {}): SpinoffRow => ({
  id: 1,
  ticket_ref: "CUE-9893",
  repo: "/r/cue-frontend",
  branch: "cue-9893-x",
  worktree: "/r/cue-frontend.cue-9893-x",
  mode: "agent",
  brief: "implement the transcript",
  status: "pending",
  error: null,
  agent_id: null,
  request_at: "2026-07-17T00:00:00Z",
  launched_at: null,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0,
  base_sha: null,
  reported_at: null,
  launcher: null,
  launch_attempts: 0,
  session_id: null,
  engine: null,
  t3_thread_id: null,
  t3_run_id: null,
  item_id: null,
  tier: null,
  model: null,
  effort: null,
  ...over,
});

/**
 * A real drain through the t3 launcher (the only one since 1589) against a fake T3 that knows every repo
 * named, with each expected worktree pre-created so `ensureWorktree` needs no git. Nothing real launches.
 */
async function drainWithFakeT3(
  db: ReturnType<typeof freshDb>,
  launchable: Array<{ repo: string; branch: string }>,
): Promise<Awaited<ReturnType<typeof drainSpinoffs>>> {
  for (const { repo, branch } of launchable) mkdirSync(worktreePath(repo, branch), { recursive: true });
  const t3 = installFakeT3([...new Set(launchable.map((l) => l.repo))]);
  try {
    return await drainSpinoffs(db);
  } finally {
    t3.restore();
  }
}

describe("spinoff pure helpers", () => {
  test("worktreePath follows the wt convention", async () => {
    expect(worktreePath("/Users/j/dev/cue-frontend", "cue-9893-x")).toBe("/Users/j/dev/cue-frontend.cue-9893-x");
  });
  test("agent command defaults to plain claude when not given", async () => {
    expect(spinoffTabCommand("/b.md")).toBe(`claude "$(cat '/b.md')"`);
  });
  // #147: an interactive row used to run `cat '<brief>.md'`: it printed the brief and exited, so the one
  // thing the mode exists for (a session a human can DRIVE) was the one thing it could not do. Both modes
  // now start Claude Code in the row's worktree carrying the brief; the mode difference is the brief's
  // CONTENTS (the operating procedure, asserted in the enqueue tests below), never the command.
  test("the command is byte-identical for both modes (#147): one setting drives both, so they cannot drift", async () => {
    const cmd = "claude --dangerously-skip-permissions --model claude-opus-5";
    expect(spinoffTabCommand("/b.md", cmd)).toBe(`${cmd} "$(cat '/b.md')"`);
    expect(spinoffTabCommand("/b.md", cmd)).not.toContain("cat '/b.md'\""); // not the bare-cat command #147 removed
  });

  test("spinoffTabCommand is the one command shape for every mode (#147)", async () => {
    expect(spinoffTabCommand("/b.md", "claude --dangerously-skip-permissions")).toBe(
      `claude --dangerously-skip-permissions "$(cat '/b.md')"`,
    );
    expect(spinoffTabCommand("/b.md")).toBe(`claude "$(cat '/b.md')"`);
  });

  // 1163: a hand-charted ticket is dispatched by its WAYFINDER number while its ob mirror carries an id
  // of its own, so a reader that resolves the ref alone names the thread after whichever item happens to
  // hold that number. The row's recorded item wins, and without one the record's own link resolves it.
  test("the thread's name comes from the item the row serves, not from a ref that names another item", async () => {
    const db = openDb(freshDbPath());
    const mirrorId = await createItem(db, {
      type: "task",
      title: "T3 integration P1",
      body: "wayfinder/tickets/1124-t3-read-surface.md — the read half",
    });
    await addTags(db, mirrorId, ["t3"]);
    // the wayfinder ref resolves to its ob mirror, through the path the item's own record names
    expect(await ticketTitleFor(db, "1124")).toBe("T3 integration P1");
    expect(await spinoffTicketTagsFor(db, "1124")).toEqual(["t3"]);
    // a recorded item wins over the ref, and an unresolvable ref names nothing rather than guessing
    const other = await createItem(db, { type: "task", title: "The item the row records" });
    expect(await ticketTitleFor(db, "1124", other)).toBe("The item the row records");
    expect(await ticketTitleFor(db, "no-such-ref")).toBeNull();
    expect(await spinoffTicketTagsFor(db, "no-such-ref")).toEqual([]);
    db.close();
  });

});

describe("operating-procedure brief (#3) — points at ob-spinoff", () => {
  const REPO = "/r/some-repo";

  test("composeBrief appends the REQUIRED directive + the report/heartbeat instructions", async () => {
    const b = composeBrief("617", "617", REPO);
    expect(b).toContain("Implement 617"); // default head
    expect(b).toContain("Operating procedure (REQUIRED)");
    expect(b).toContain("ob-spinoff");
    expect(b).toContain("Run the `ob-spinoff` skill now and follow it end to end");
    expect(b).toContain("REPORT each gate via `ob agent register --id 617 --status <s> --note <...>`");
    expect(b).toContain("a gate you did not report reads as skipped");
    expect(b).toContain("ob agent heartbeat 617");
  });

  test("a custom head is kept and still gets the procedure appended", async () => {
    const b = composeBrief("617", "617", REPO, "Wire the transcript endpoint, paginated.");
    expect(b.startsWith("Wire the transcript endpoint, paginated.")).toBe(true);
    expect(b).toContain("Operating procedure (REQUIRED)");
    expect(b).toContain("ob-spinoff");
  });

  test("operatingProcedure is byte-for-byte the appended procedure", async () => {
    const b = composeBrief("617", "617", REPO);
    expect(b.endsWith(operatingProcedure("617", "617", REPO))).toBe(true);
  });
});

describe("selectProcedure: repo -> skill prefix (#3)", () => {
  test("every repo, including Cue-looking names, is ob", async () => {
    expect(selectProcedure("acmecorp/cue-frontend")).toBe("ob");
    expect(selectProcedure("cue-frontend")).toBe("ob");
    expect(selectProcedure("/Users/j/dev/cue-frontend")).toBe("ob");
    expect(selectProcedure("/r/cue-frontend.cue-9893-x")).toBe("ob");
    expect(selectProcedure("cue-app")).toBe("ob");
    expect(selectProcedure("acmecorp/cue-backend")).toBe("ob");
    expect(selectProcedure("/r/cb-some-agent-checkout")).toBe("ob");
    expect(selectProcedure("/r/cf-some-agent-checkout")).toBe("ob");
    expect(selectProcedure("/Users/owner/dev/omnislash")).toBe("ob");
    expect(selectProcedure("/Users/owner/dev/omnislash.dogfood-brief")).toBe("ob");
    expect(selectProcedure("owner/omnislash")).toBe("ob");
    expect(selectProcedure("")).toBe("ob");
    expect(selectProcedure(undefined)).toBe("ob");
  });
});

describe("context-aware operating procedure (#3)", () => {
  test("an omnislash ticket's brief points at ob-spinoff, NOT cf/cb", async () => {
    const b = composeBrief("157", "157-context-aware-spinoff-brief", "/Users/owner/dev/omnislash");
    expect(b).toContain("Implement 157"); // default head
    expect(b).toContain("Run the `ob-spinoff` skill now");
    expect(b).toContain(`ob agent heartbeat 157-context-aware-spinoff-brief`);
    expect(b).toContain(
      `REPORT each gate via \`ob agent register --id 157-context-aware-spinoff-brief --status <s> --note <...>\``,
    );
    expect(b).not.toContain("cf-spinoff");
    expect(b).not.toContain("cb-spinoff");
  });

  test("a Cue-looking repo's brief still points at ob-spinoff", async () => {
    const b = composeBrief("CUE-100", "cue-100", "acmecorp/cue-backend");
    expect(b).toContain("Run the `ob-spinoff` skill now");
    expect(b).not.toContain("cf-spinoff");
    expect(b).not.toContain("cb-spinoff");
  });

  test("a custom head is kept and still gets the procedure appended", async () => {
    const b = composeBrief("157", "157-x", "/Users/owner/dev/omnislash", "Make the brief context-aware.");
    expect(b.startsWith("Make the brief context-aware.")).toBe(true);
    expect(b).toContain("Run the `ob-spinoff` skill now");
  });
});

describe("the launch message is the ticket's own brief (1162)", () => {
  // The ticket's own shape is the format: its title + the three sections a reader needs to follow a
  // build. `## Work log` and the frontmatter are the record, NOT the order, and must not leak in.
  const TICKET = [
    "---",
    "id: 1162",
    'title: "A spinoff thread opens with its brief and acceptance criteria"',
    "status: open",
    "---",
    "",
    "## What to build",
    "",
    "Inline the ticket's own sections into the launch message.",
    "",
    "## Acceptance",
    "",
    "- the thread's first message IS the brief",
    "- tests for the composition",
    "",
    "## Do not",
    "",
    "- do not paste the whole file",
    "",
    "## Work log",
    "",
    "- 2026-10-17 — opened",
    "",
  ].join("\n");

  test("the ticket's four pieces are inlined; Context/Work log and frontmatter are not", () => {
    const brief = ticketBrief("1162", { file: TICKET })!;
    expect(brief.startsWith("1162 · A spinoff thread opens with its brief and acceptance criteria")).toBe(true);
    expect(brief).toContain("## What to build\n\nInline the ticket's own sections into the launch message.");
    expect(brief).toContain("## Acceptance\n\n- the thread's first message IS the brief");
    expect(brief).toContain("## Do not\n\n- do not paste the whole file");
    // the RECORD is not the work order
    expect(brief).not.toContain("## Work log");
    expect(brief).not.toContain("2026-10-17 — opened");
    expect(brief).not.toContain("status: open");
    expect(brief).not.toContain("id: 1162");
    // ...and it ends by naming the skill as a DIRECTIVE, not a self-gating procedure (563)
    expect(brief).toContain("Run the `ob-spinoff` skill now and follow it end to end");
    expect(brief).not.toContain("REPORT each gate");
    expect(brief).not.toContain("heartbeat");
  });

  test("a ticket missing ## Acceptance still composes from the sections it HAS", () => {
    const brief = ticketBrief("1162", { file: "---\ntitle: Thin\n---\n\n## What to build\n\nDo the thing.\n" })!;
    expect(brief).toContain("1162 · Thin");
    expect(brief).toContain("## What to build\n\nDo the thing.");
    expect(brief).not.toContain("## Acceptance");
    expect(brief).not.toContain("## Do not");
    // a heading that is not one of the three is not dragged in either
    expect(ticketBrief("1162", { file: "## Notes\n\nsomething\n## Acceptance\n\nok\n" })).not.toContain("## Notes");
  });

  test("no ticket file → the ob item's title + body (the second fallback)", () => {
    const brief = ticketBrief("CUE-7", { file: null, item: { title: "Wire the endpoint", body: "Paginate it." } })!;
    expect(brief.split("\n\n")[0]).toBe("CUE-7 · Wire the endpoint");
    expect(brief).toContain("Paginate it.");
    expect(brief).toContain("Run the `ob-spinoff` skill now");
  });

  test("neither file nor item → today's pointer, byte-for-byte and with nothing appended (563)", async () => {
    expect(ticketBrief("1162", {})).toBeNull();
    const pointer = `Read 1162's brief and implement per its acceptance criteria.`;
    expect(spinoffAsk("1162")).toBe(pointer);
    expect(await spinoffAskFor(null, null, "1162")).toBe(pointer);
    // an empty file/body is nothing usable, not an empty brief
    expect(await spinoffAskFor(null, null, "1162", {})).toBe(pointer);
    expect(ticketBrief("1162", { file: "   \n", item: { title: " ", body: "" } })).toBeNull();
  });

  test("a caller-supplied --brief wins outright (unchanged)", async () => {
    expect(await spinoffAskFor(null, "/nowhere/omnislash", "1162", { brief: "do the transcript" })).toBe("do the transcript");
    expect(await spinoffAskFor(null, null, "1162", { brief: "" })).toBe(""); // an empty brief is a brief
  });

  test("a #<n> ref is a GITHUB ISSUE: its own head, never the local file of the same number (221/1162)", async () => {
    // `#` is the disambiguator: `#42` is an issue, while wayfinder/tickets/42-*.md is a DIFFERENT ticket.
    // Reading the file for a `#<n>` ref would inline the wrong ticket's work order.
    const repo = fakeRepoDir();
    mkdirSync(join(repo, "wayfinder", "tickets"), { recursive: true });
    writeFileSync(join(repo, "wayfinder", "tickets", "42-some-local-ticket.md"), "---\ntitle: A local ticket\n---\n\n## What to build\n\nLocal work.\n");
    const head = "Implement GitHub issue #42: the real issue\n\nIts body.";
    const brief = await spinoffAskFor(null, repo, "#42", { issueHead: head });
    expect(brief).toBe(head);
    expect(brief).not.toContain("A local ticket");
    // and an explicit --brief still beats the issue head
    expect(await spinoffAskFor(null, repo, "#42", { brief: "do this instead", issueHead: head })).toBe("do this instead");
  });

  test("a very large ticket is cut at a line boundary, marked, never pasted whole", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} of the work order`).join("\n");
    const brief = ticketBrief("1162", { file: `---\ntitle: Huge\n---\n\n## What to build\n\n${lines}\n` })!;
    expect(brief).toContain("[cut at 20000 characters");
    expect(brief).toContain("wayfinder/tickets/1162-*.md");
    // cut on a LINE boundary: the last thing kept is a whole line, not a fragment of one
    const kept = brief.slice(0, brief.indexOf("\n\n[cut at"));
    expect(/line \d+ of the work order$/.test(kept)).toBe(true);
    // the directive still arrives after the cut, so the message is still an ask
    expect(brief.indexOf("Run the `ob-spinoff` skill now")).toBeGreaterThan(brief.indexOf("[cut at"));
  });

  test("the cut marker names the source it cut — an item's rest is not a ticket file", () => {
    const brief = ticketBrief("CUE-7", { item: { title: "Huge", body: "y".repeat(20500) } })!;
    expect(brief).toContain("[cut at 20000 characters");
    expect(brief).toContain("the ob item CUE-7 (ob show CUE-7)");
    expect(brief).not.toContain("wayfinder/tickets/");
  });

  test("a drilled ticket past 6000 characters keeps its Done when in the launch text", () => {
    const filler = Array.from({ length: 140 }, (_, i) => `Drilled note ${i}: context the builder needs.`).join("\n");
    const body = `## Drilled\n\n${filler}\n\n## Done when\n\n- DONE-WHEN-SENTINEL: the cut lifted to 20000.\n`;
    expect(body.length).toBeGreaterThan(6000);
    expect(body.length).toBeLessThan(20000);
    const brief = ticketBrief("OB-9999", { item: { title: "Drilled", body } })!;
    expect(brief).toContain("DONE-WHEN-SENTINEL");
    expect(brief).not.toContain("[cut at");
  });

  test("absence falls back; an unreadable ticket file is REPORTED, not a silent pointer", async () => {
    const repo = fakeRepoDir();
    mkdirSync(join(repo, "wayfinder", "tickets"), { recursive: true });
    const path = join(repo, "wayfinder", "tickets", "1162-thread-brief.md");
    writeFileSync(path, TICKET);
    chmodSync(path, 0o000);
    try {
      await expect(spinoffAskFor(null, repo, "1162")).rejects.toThrow();
    } finally {
      chmodSync(path, 0o600);
    }
    // a checkout that is not there at all is ABSENCE, and the fallbacks still apply
    expect(await spinoffAskFor(null, join(repo, "no-such-checkout", "omnislash"), "1162")).toBe(spinoffAsk("1162"));
  });

  test("an on-disk ticket file is what spinoffAskFor reads (the checkout, not the network)", async () => {
    const repo = fakeRepoDir();
    mkdirSync(join(repo, "wayfinder", "tickets"), { recursive: true });
    writeFileSync(join(repo, "wayfinder", "tickets", "1162-thread-brief.md"), TICKET);
    const brief = await spinoffAskFor(null, repo, "1162");
    expect(brief).toContain("## Acceptance");
    // the item is the fallback BEHIND the file: a store here cannot override a file that exists
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "An item title", body: "An item body." });
    // OB-2103: with a store, the stage block (not set, so beta) rides on the same brief
    expect(await spinoffAskFor(db, repo, "1162")).toBe(withStage(brief));
    const itemBrief = await spinoffAskFor(db, repo, id);
    expect(itemBrief).toContain("An item title");
    expect(itemBrief).toContain("An item body.");
  });

  test("a client's ONE item read is the fallback, and a ticket file still beats it (1190)", async () => {
    // `db = null` is a client: no store, but a wire it is allowed to use once per launch message.
    const reads: string[] = [];
    const readItem = async () => {
      reads.push("read");
      return { title: "Thread brief from the item", body: "The item's own body." };
    };
    const brief = await spinoffAskFor(null, "/nowhere", "738", { readItem });
    expect(brief.split("\n\n")[0]).toBe("738 · Thread brief from the item");
    expect(brief).toContain("The item's own body.");
    expect(brief).toContain("Run the `ob-spinoff` skill now");
    expect(reads).toHaveLength(1);
    // the FILE is the work order: where it exists the wire is not touched at all
    const repo = fakeRepoDir();
    mkdirSync(join(repo, "wayfinder", "tickets"), { recursive: true });
    writeFileSync(join(repo, "wayfinder", "tickets", "1162-thread-brief.md"), TICKET);
    reads.length = 0;
    const fromFile = await spinoffAskFor(null, repo, "1162", { readItem });
    expect(fromFile).toContain("## Acceptance");
    expect(fromFile).not.toContain("Thread brief from the item");
    expect(reads).toEqual([]);
  });

  test("a failed item read is a FALLTHROUGH, never a failed dispatch (1190)", async () => {
    const pointer = spinoffAsk("738");
    // a read that throws (a dead API, a 500) opens the thread on the pointer, unchanged
    expect(
      await spinoffAskFor(null, null, "738", {
        readItem: async () => {
          throw new Error("the tracker is down");
        },
      }),
    ).toBe(pointer);
    // ...and so does a read that finds NO item: a missing item is not an error
    expect(await spinoffAskFor(null, null, "738", { readItem: async () => null })).toBe(pointer);
  });

  test("the pieces: a `# ` heading is a title too, `###` stays in its section, and the directive names the skill", () => {
    // no frontmatter title → the leading `# ` heading is the title
    expect(ticketBrief("1162", { file: "# plain heading\n\n## What to build\n\nx\n" })!.split("\n")[0]).toBe("1162 · plain heading");
    // a YAML-quoted title is unquoted and unescaped: a reader should not see `\"` in the message
    expect(ticketBrief("1162", { file: '---\ntitle: "says \\"hi\\""\n---\n\n## Acceptance\n\nok\n' })!.split("\n")[0]).toBe('1162 · says "hi"');
    // no title at all is not fatal: the ref alone heads the work order
    expect(ticketBrief("1162", { file: "---\nid: 1\n---\n\n## What to build\n\nx\n" })!.split("\n")[0]).toBe("1162");
    // `###` is a sub-heading: it belongs INSIDE its `##` section, not beside it
    const brief = ticketBrief("1162", { file: "## Acceptance\n\n- a\n\n### Note\n\n- b\n\n## Do not\n\n- c\n" })!;
    expect(brief).toContain("## Acceptance\n\n- a\n\n### Note\n\n- b");
    expect(brief).toContain("## Do not\n\n- c");
    // exactly the three work-order headings are inlined, as headings (`### Note` is not one of them)
    expect(brief.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## Acceptance", "## Do not"]);
    expect(brief.endsWith("Run the `ob-spinoff` skill now and follow it end to end (it is in your skills; invoke it).")).toBe(true);
  });
});

describe("CLI: the enqueued launch message is the ticket's brief (1162)", () => {
  const TICKET = "---\ntitle: Thread brief\n---\n\n## What to build\n\nCompose it.\n\n## Acceptance\n\nIt opens with the brief.\n";

  test("ob spinoff <ref> stores the composed brief; ob spinoff brief prints the same text", async () => {
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    mkdirSync(join(repo, "wayfinder", "tickets"), { recursive: true });
    writeFileSync(join(repo, "wayfinder", "tickets", "1162-thread-brief.md"), TICKET);

    const r = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "1162", "--repo", repo, "--branch", "1162"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
    const brief = rows[0]!.brief;
    expect(brief).toContain("1162 · Thread brief");
    expect(brief).toContain("## What to build");
    expect(brief).toContain("## Acceptance");
    expect(brief).not.toContain("Read 1162's brief and implement");
    // the dry run is the dry run OF the launch message: the same bytes the row carries
    const dry = await runCli(dbPath, ["spinoff", "brief", "1162", "--repo", repo, "--branch", "1162"]);
    expect(dry.code).toBe(0);
    expect(dry.out.trimEnd()).toBe(brief.trimEnd());
  });

  test("no ticket file in the checkout → the ob item's title + body", async () => {
    const dbPath = freshDbPath();
    const repo = fakeRepoDir(); // no wayfinder/tickets
    const db = openDb(dbPath);
    const id = await createItem(db, { type: "task", title: "Wire the endpoint", body: "Paginate it." });
    const r = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", id, "--repo", repo]);
    expect(r.code).toBe(0);
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
    expect(rows[0]!.brief).toContain(`${id} · Wire the endpoint`);
    expect(rows[0]!.brief).toContain("Paginate it.");
  });

  test("a ref with neither file nor item still queues today's pointer", async () => {
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "CUE-4242", "--repo", fakeRepoDir(), "--branch", "cue-4242"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
    expect(rows[0]!.brief).toBe(withStage(`Read CUE-4242's brief and implement per its acceptance criteria.`));
  });
});

describe("CLI: spinoff is always interactive (563)", () => {
  test("enqueue stores the bare ask, not the operating procedure", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "CUE-9893", "--repo", fakeRepoDir(), "--branch", "cue-9893", "--brief", "do the transcript"]);
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
    expect(rows[0]!.mode).toBe("interactive");
    expect(rows[0]!.brief).toBe(withStage("do the transcript"));
    expect(rows[0]!.brief).not.toContain("Operating procedure");
    expect(rows[0]!.brief).not.toContain("ob-spinoff");
  });

  test("--agent is a usage error", async () => {
    const r = await runCli(freshDbPath(), ["spinoff", "queue", "CUE-9893", "--repo", fakeRepoDir(), "--agent"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("spinoff --agent is gone");
  });

  test("--interactive is a silent alias of the only mode", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "CUE-9893", "--repo", fakeRepoDir(), "--branch", "cue-9893", "--interactive", "--brief", "just read this"]);
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
    const row = rows[0]!;
    expect(row.mode).toBe("interactive");
    expect(row.brief).toBe(withStage("just read this"));
    expect(row.brief).not.toContain("Operating procedure");
  });
});

describe("enqueue + dedup", () => {
  test("inserts a pending row; a second enqueue for the same ticket dedups (keeps the first)", async () => {
    const db = freshDb();
    const a = (await enqueueSpinoff(db, input()));
    expect(a.deduped).toBe(false);
    expect(a.row.status).toBe("pending");
    // OB-1992: cue-frontend is a clean repo, so its worktree keeps the ref whatever the branch is called.
    expect(a.row.worktree).toBe("/r/cue-frontend.cue-9893");

    const b = (await enqueueSpinoff(db, input({ brief: "different" })));
    expect(b.deduped).toBe(true);
    expect(b.row.id).toBe(a.row.id);
    expect((await listSpinoffs(db))).toHaveLength(1);
    expect(b.row.brief).toBe("implement the transcript"); // dedup did not overwrite
  });

  test("a re-dispatch of a launching, building or handed-off ticket reuses its live row; a failed or landed one queues anew", async () => {
    for (const live of ["launching", "launched", "ready-for-gate"]) {
      const db = freshDb();
      const a = await enqueueSpinoff(db, input({ tier: "simple" }));
      db.query("UPDATE spinoff SET status = ? WHERE id = ?").run(live, a.row.id);
      // A named tier re-rates only a PENDING row: the live row keeps the rating it was launched at.
      const b = await enqueueSpinoff(db, input({ brief: "different", tier: "complex" }));
      expect(b.deduped).toBe(true);
      expect(b.row.id).toBe(a.row.id);
      expect(b.row.status).toBe(live);
      expect(b.row.tier).toBe("simple");
      expect(await listSpinoffs(db)).toHaveLength(1);
    }
    for (const dead of ["failed", "merged"]) {
      const db = freshDb();
      const a = await enqueueSpinoff(db, input());
      db.query("UPDATE spinoff SET status = ? WHERE id = ?").run(dead, a.row.id);
      const b = await enqueueSpinoff(db, input());
      expect(b.deduped).toBe(false);
      expect(b.row.id).not.toBe(a.row.id);
      expect(await listSpinoffs(db)).toHaveLength(2);
    }
  });

  test("a trial's leg b gets its own row beside a building leg a, and dedupes only onto another leg b (OB-1991)", async () => {
    const db = freshDb();
    const a = await enqueueSpinoff(db, input({ trialLeg: "a", trialModel: "m-a" }));
    db.query("UPDATE spinoff SET status = 'launched' WHERE id = ?").run(a.row.id);
    const b = await enqueueSpinoff(db, input({ branch: "cue-9893-x-b", trialLeg: "b", trialModel: "m-b" }));
    expect(b.deduped).toBe(false);
    expect(b.row.trial_leg).toBe("b");
    db.query("UPDATE spinoff SET status = 'launched' WHERE id = ?").run(b.row.id);
    const again = await enqueueSpinoff(db, input({ branch: "cue-9893-x-b", trialLeg: "b", trialModel: "m-b" }));
    expect(again.deduped).toBe(true);
    expect(again.row.id).toBe(b.row.id);
    // A single dispatch of a ticket whose pair is live reuses a live row too.
    expect((await enqueueSpinoff(db, input())).deduped).toBe(true);
    expect(await listSpinoffs(db)).toHaveLength(2);
  });

  test("an explicit --worktree overrides the derived <repo>.<branch> path (#61)", async () => {
    const db = freshDb();
    const { row } = (await enqueueSpinoff(db, input({ worktree: "/custom/existing-checkout" })));
    expect(row.worktree).toBe("/custom/existing-checkout");
  });

  test("distinct tickets each get a pending row", async () => {
    const db = freshDb();
    (await enqueueSpinoff(db, input({ ticketRef: "CUE-1", branch: "cue-1" })));
    (await enqueueSpinoff(db, input({ ticketRef: "CUE-2", branch: "cue-2" })));
    expect((await listSpinoffs(db))).toHaveLength(2);
    expect((await listSpinoffs(db, "pending"))).toHaveLength(2);
  });
});

describe("claimSpinoffRow (191, replacing claimPending/claimPendingById)", () => {
  test("claims a specific pending row by id; returns null once it's no longer pending", async () => {
    const db = freshDb();
    const a = (await enqueueSpinoff(db, input({ ticketRef: "CUE-1", branch: "cue-1" })));
    const b = (await enqueueSpinoff(db, input({ ticketRef: "CUE-2", branch: "cue-2" })));
    const claimed = (await claimSpinoffRow(db, b.row.id)); // claim the NEWER one, not the oldest
    expect(claimed.claimed?.ticket_ref).toBe("CUE-2");
    expect(claimed.claimed?.status).toBe("launching");
    expect((await claimSpinoffRow(db, b.row.id)).claimed).toBeNull(); // already launching → no re-claim
    expect((await listSpinoffs(db, "pending")).map((s) => s.ticket_ref)).toEqual(["CUE-1"]); // CUE-1 untouched
    expect((await claimSpinoffRow(db, a.row.id)).claimed?.ticket_ref).toBe("CUE-1");
  });

  test("a row that does not exist claims nothing", async () => {
    expect((await claimSpinoffRow(freshDb(), 404)).claimed).toBeNull();
  });
});

describe("drain launches regardless of live agent count (ob 767)", () => {
  test("empty queue drains to nothing", async () => {
    const r = (await drainSpinoffs(freshDb()));
    expect(r.launched).toEqual([]);
    expect(r.remaining_pending).toBe(0);
    expect(r.active).toBe(0);
  });

  test("isCoordinatorAgent: only a team role row (architect-*, sentinel-*, muse-*, OB-2255)", async () => {
    expect(isCoordinatorAgent("architect-omnislash")).toBe(true);
    expect(isCoordinatorAgent("sentinel-slash")).toBe(true);
    expect(isCoordinatorAgent("muse-slash")).toBe(true);
    expect(isCoordinatorAgent("architect")).toBe(false);
    expect(isCoordinatorAgent("planner-omnislash")).toBe(false);
    expect(isCoordinatorAgent("lander-omnislash")).toBe(false);
    expect(isCoordinatorAgent("cue-9893-x")).toBe(false);
    expect(isCoordinatorAgent("177")).toBe(false);
  });

  test("a cwd defaults to its repo: there is no shared-checkout refusal any more (OB-2255)", async () => {
    const inDir = async (dirName: string, dbPath: string, args: string[]) => {
      const dir = join(mkdtempSync(join(tmpdir(), "ob-cwd-")), dirName);
      mkdirSync(dir, { recursive: true });
      const prev = process.cwd();
      process.chdir(dir);
      try {
        return await runCli(dbPath, args);
      } finally {
        process.chdir(prev);
      }
    };
    const dbPath = freshDbPath();
    expect((await inDir("omnislash", dbPath, ["spinoff", "brief", "77"])).code).toBe(0);
    expect((await inDir("cue-frontend", dbPath, ["spinoff", "brief", "77"])).code).toBe(0);
  });

  // Seed an in-flight BUILD agent exactly as the drain produces one: a `launched` spinoff row
  // (agent_id = branch) + its live registry row, so the agent maps to `repo` via the join
  // (agent.id === spinoff.agent_id → spinoff.repo).
  const seedLive = async (
    db: ReturnType<typeof freshDb>,
    repo: string,
    branch: string,
    ticket = branch,
    agentId = branch,
  ) => {
    const { row } = (await enqueueSpinoff(db, input({ ticketRef: ticket, repo, branch })));
    db.query("UPDATE spinoff SET status = 'launched', agent_id = ? WHERE id = ?").run(agentId, row.id);
    (await registerAgent(db, { id: agentId, ticket, branch, worktree: worktreePath(repo, branch), status: "working", ttlS: 900 }));
  };

  // Run a real drain through the t3 launcher against a fake T3 (no real thread), pre-creating the
  // worktree dir for each branch expected to launch so `ensureWorktree` is a no-op (no real git).
  const drainT3 = async (
    db: ReturnType<typeof freshDb>,
    launchable: Array<{ repo: string; branch: string }>,
  ): Promise<Awaited<ReturnType<typeof drainSpinoffs>>> => drainWithFakeT3(db, launchable);

  test("drain/launch registers the builder with ticket and branch (ob 640)", async () => {
    const db = freshDb();
    const { row } = await enqueueSpinoff(db, input({ ticketRef: "640", repo: "/r/omnislash", branch: "640-branch", worktree: "/wt/640" }));
    await claimSpinoffRow(db, row.id); // OB-1920: a launch stamp needs a claimed (launching) row, as the drain makes
    await stampSpinoff(db, { id: row.id, outcome: "launched", worktree: "/wt/640", launcher: "t3" });
    const agent = await getAgent(db, "640-branch");
    expect(agent?.ticket).toBe("640");
    expect(agent?.branch).toBe("640-branch");
    // 1189: the launcher no longer writes the `launching` bookend (that word is the spinoff row's now);
    // the row is created with NO workflow word — the agent's own first register is what claims one. And the
    // stamp itself invents no run: T3's run state is the mirror's to write.
    expect(agent?.run).toBeNull();
    expect(agent?.status).toBeNull();
  });

  test("agentRepoMap maps a launched row's agent_id → its repo", async () => {
    const db = freshDb();
    await seedLive(db, "/r/A", "a1");
    await seedLive(db, "/r/B", "b1");
    const m = (await agentRepoMap(db));
    expect(m.get("a1")).toBe("/r/A");
    expect(m.get("b1")).toBe("/r/B");
    expect(m.size).toBe(2);
  });

  test("liveBuildAgentsByRepo: per-repo counts; team role rows excluded; unmapped counted in total only", async () => {
    const db = freshDb();
    await seedLive(db, "/r/A", "a1");
    await seedLive(db, "/r/A", "a2");
    await seedLive(db, "/r/B", "b1");
    await seedLive(db, "/r/A", "architect-a", "architect-a", "architect-a"); // a team role row is excluded even with a launched row
    (await registerAgent(db, { id: "loose", ticket: "x", status: "working", ttlS: 900 })); // not a team role, no spinoff row
    const { perRepo, total } = (await liveBuildAgentsByRepo(db));
    expect(perRepo.get("/r/A")).toBe(2); // a1, a2 (architect-a excluded)
    expect(perRepo.get("/r/B")).toBe(1);
    expect(total).toBe(4); // a1, a2, b1, loose (architect excluded); loose in total but no repo
  });

  test("live agents in one repo do not hold back pending rows in that repo or another", async () => {
    const db = freshDb();
    const base = mkdtempSync(join(tmpdir(), "ob-perrepo-"));
    const repoA = join(base, "A");
    const repoB = join(base, "B");
    await seedLive(db, repoA, "a-live");
    (await enqueueSpinoff(db, input({ ticketRef: "A-2", repo: repoA, branch: "a-2" })));
    (await enqueueSpinoff(db, input({ ticketRef: "B-1", repo: repoB, branch: "b-1" })));
    let r: Awaited<ReturnType<typeof drainSpinoffs>>;
    try {
      r = await drainT3(db, [
        { repo: repoA, branch: "a-2" },
        { repo: repoB, branch: "b-1" },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    expect(r.launched).toEqual(["A-2", "B-1"]);
    expect((await listSpinoffs(db, "pending")).map((s) => s.ticket_ref)).toEqual([]);
  });

  test("architect-* agents do not prevent a pending row from launching", async () => {
    const db = freshDb();
    const base = mkdtempSync(join(tmpdir(), "ob-architect-"));
    const repoA = join(base, "A");
    await seedLive(db, repoA, "architect-a", "architect-a", "architect-a");
    (await enqueueSpinoff(db, input({ ticketRef: "A-1", repo: repoA, branch: "a-1" })));
    let r: Awaited<ReturnType<typeof drainSpinoffs>>;
    try {
      r = await drainT3(db, [{ repo: repoA, branch: "a-1" }]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    expect(r.launched).toEqual(["A-1"]);
  });

  test("every pending row in a repo launches even when live builders already occupy it", async () => {
    const base = mkdtempSync(join(tmpdir(), "ob-nocap-"));
    const repo = join(base, "A");
    try {
      const db = freshDb();
      await seedLive(db, repo, "live-1");
      await seedLive(db, repo, "live-2");
      (await enqueueSpinoff(db, input({ ticketRef: "Q-1", repo, branch: "q-1" })));
      (await enqueueSpinoff(db, input({ ticketRef: "Q-2", repo, branch: "q-2" })));
      const r = await drainT3(db, [
        { repo, branch: "q-1" },
        { repo, branch: "q-2" },
      ]);
      expect(r.launched).toEqual(["Q-1", "Q-2"]);
      expect(r.remaining_pending).toBe(0);
      expect((await listSpinoffs(db, "pending")).map((s) => s.ticket_ref)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an expired builder does not block the next tab (ob 767)", async () => {
    const base = mkdtempSync(join(tmpdir(), "ob-ttl-"));
    const repo = join(base, "A");
    try {
      const db = freshDb();
      await seedLive(db, repo, "crashed");
      db.query(
        "UPDATE agent SET heartbeat_at = '2000-01-01T00:00:00Z', started_at = '2000-01-01T00:00:00Z' WHERE id = 'crashed'",
      ).run();
      expect((await listAgents(db)).map((a) => a.id)).toEqual([]); // TTL hides it from the live list
      expect((await liveBuildAgentsByRepo(db)).perRepo.get(repo)).toBe(1); // still counted, informational
      (await enqueueSpinoff(db, input({ ticketRef: "NEXT", repo, branch: "next" })));
      const r = await drainT3(db, [{ repo, branch: "next" }]);
      expect(r.launched).toEqual(["NEXT"]);
      expect((await listSpinoffs(db, "pending")).map((s) => s.ticket_ref)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// #151: the app reports a spawn that produced no session (#146's report path), and the ROW has to
// answer for it too: it kept saying `launched`, which leaves nothing to re-enqueue.
describe("reported spawn failure → the spinoff row (#151)", () => {
  const REASON = "spawn produced no session: forkpty failed (errno 35)";

  // A real drain through the t3 launcher against a fake T3, so `launch_attempts` is incremented by the
  // code that actually launches rather than by the test.
  const drainT3 = (db: ReturnType<typeof freshDb>, launchable: Array<{ repo: string; branch: string }>) =>
    drainWithFakeT3(db, launchable);

  const withRepo = async (fn: (repo: string) => void | Promise<void>): Promise<void> => {
    const base = mkdtempSync(join(tmpdir(), "ob-spawnfail-"));
    try {
      await fn(join(base, "R"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };

  test("the row leaves `launched`: re-queued as pending with the reported reason", async () => {
    await withRepo(async (repo) => {
      const db = freshDb();
      (await enqueueSpinoff(db, input({ ticketRef: "S-1", repo, branch: "s-1" })));
      expect((await drainT3(db, [{ repo, branch: "s-1" }])).launched).toEqual(["S-1"]);

      const rec = (await recordSpinoffSpawnFailure(db, "s-1", REASON));

      expect(rec).toEqual({ id: 1, ticket: "S-1", branch: "s-1", status: "pending", attempts: 1, retrying: true });
      const row = (await listSpinoffs(db)).find((s) => s.ticket_ref === "S-1")!;
      expect(row.status).toBe("pending"); // NOT `launched`: nothing ran
      expect(row.error).toBe(REASON);
      expect(row.agent_id).toBeNull(); // it claims no agent it does not have
      expect(row.launched_at).toBeNull();
    });
  });

  test("the next drain relaunches it after a reported spawn failure", async () => {
    await withRepo(async (repo) => {
      const db = freshDb();
      (await enqueueSpinoff(db, input({ ticketRef: "S-1", repo, branch: "s-1" })));
      await drainT3(db, [{ repo, branch: "s-1" }]);
      expect((await liveBuildAgentsByRepo(db)).perRepo.get(repo)).toBe(1);

      (await recordSpinoffSpawnFailure(db, "s-1", REASON));

      expect((await liveBuildAgentsByRepo(db)).perRepo.get(repo)).toBeUndefined();
      const again = await drainT3(db, [{ repo, branch: "s-1" }]);
      expect(again.launched).toEqual(["S-1"]);
      const row = (await listSpinoffs(db)).find((s) => s.ticket_ref === "S-1")!;
      expect(row.status).toBe("launched");
      expect(row.launch_attempts).toBe(2); // the retry is spent
    });
  });

  test("the retry is bounded: the second reported failure is terminal `failed`, and no drain relaunches it", async () => {
    await withRepo(async (repo) => {
      const db = freshDb();
      (await enqueueSpinoff(db, input({ ticketRef: "S-1", repo, branch: "s-1" })));
      await drainT3(db, [{ repo, branch: "s-1" }]);
      (await recordSpinoffSpawnFailure(db, "s-1", REASON)); // attempt 1 failed → one retry
      await drainT3(db, [{ repo, branch: "s-1" }]); // relaunched: attempts == MAX

      const rec = (await recordSpinoffSpawnFailure(db, "s-1", REASON));

      expect(rec).toMatchObject({ status: "failed", attempts: MAX_LAUNCH_ATTEMPTS, retrying: false });
      expect((await listSpinoffs(db)).find((s) => s.ticket_ref === "S-1")!.status).toBe("failed");
      expect((await listSpinoffs(db, "pending"))).toEqual([]);
      expect((await drainT3(db, [{ repo, branch: "s-1" }])).launched).toEqual([]); // a failed row is not re-enqueued
    });
  });

  test("the failed launch's ticket/worktree leases are released, so the retry (or a human) can take them", async () => {
    await withRepo(async (repo) => {
      const db = freshDb();
      (await enqueueSpinoff(db, input({ ticketRef: "S-1", repo, branch: "s-1" })));
      await drainT3(db, [{ repo, branch: "s-1" }]);
      expect((await liveHold(db, ticketLeaseKey("S-1")!))?.holder).toBe("s-1");

      (await recordSpinoffSpawnFailure(db, "s-1", REASON));

      expect((await liveHold(db, ticketLeaseKey("S-1")!))).toBeNull();
    });
  });

  test("a launch nothing reported a failure for is untouched, and an unknown id changes nothing", async () => {
    await withRepo(async (repo) => {
      const db = freshDb();
      (await enqueueSpinoff(db, input({ ticketRef: "S-1", repo, branch: "s-1" })));
      (await enqueueSpinoff(db, input({ ticketRef: "S-2", repo, branch: "s-2" })));
      await drainT3(db, [
        { repo, branch: "s-1" },
        { repo, branch: "s-2" },
      ]);

      expect((await recordSpinoffSpawnFailure(db, "architect-omnislash", REASON))).toBeNull(); // no spinoff row at all
      (await recordSpinoffSpawnFailure(db, "s-1", REASON));

      const s2 = (await listSpinoffs(db)).find((s) => s.ticket_ref === "S-2")!;
      expect(s2.status).toBe("launched"); // the healthy launch is not collateral
      expect(s2.agent_id).toBe("s-2");
      expect(s2.error).toBeNull();
    });
  });

  test("a merged row is never revived by a late report", async () => {
    await withRepo(async (repo) => {
      const db = freshDb();
      const { row } = (await enqueueSpinoff(db, input({ ticketRef: "S-1", repo, branch: "s-1" })));
      db.query("UPDATE spinoff SET status = 'merged', agent_id = 's-1' WHERE id = ?").run(row.id);
      expect((await recordSpinoffSpawnFailure(db, "s-1", REASON))).toBeNull();
      expect((await listSpinoffs(db)).find((s) => s.ticket_ref === "S-1")!.status).toBe("merged");
    });
  });
});

describe("workHasLanded (932)", () => {
  test("done ticket or an origin/main squash counts; an open ticket and a different scope do not", () => {
    expect(workHasLanded("922", { status: "done", commits: [] })).toBe(true);
    expect(workHasLanded("922", { status: "open", commits: [{ sha: "a", subject: "fix(ob 922): paint", body: "" }] })).toBe(true);
    expect(workHasLanded("918", { status: "open", commits: [{ sha: "b", subject: "chart(ob 911): out of scope", body: "" }] })).toBe(false);
    expect(workHasLanded("917", { status: "open", commits: [] })).toBe(false);
  });
});

describe("reconcile (PR merged → done)", () => {
  // simulate a launched spinoff + its live agent, without invoking the real launcher
  const seedLaunched = async (db: ReturnType<typeof freshDb>, ticket: string, branch: string) => {
    const { row } = (await enqueueSpinoff(db, input({ ticketRef: ticket, branch })));
    db.query("UPDATE spinoff SET status = 'launched', agent_id = ? WHERE id = ?").run(branch, row.id);
    (await registerAgent(db, { id: branch, ticket, branch, status: "working", ttlS: 900 }));
  };

  test("merged PR → row marked 'merged' + agent deregistered (slot freed)", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-1", "cue-1");
    await seedLaunched(db, "CUE-2", "cue-2");
    expect((await listAgents(db))).toHaveLength(2);

    // only cue-1's PR is merged (countUnique stubbed, this test is about merge detection, not #60/#61)
    const rec = (await reconcileSpinoffs(db, (_repo, branch) => branch === "cue-1", undefined, () => 1));
    expect(rec.merged).toEqual(["CUE-1"]);
    expect((await listSpinoffs(db, "merged")).map((r) => r.ticket_ref)).toEqual(["CUE-1"]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["CUE-2"]);
    expect((await listAgents(db)).map((a) => a.id)).toEqual(["cue-2"]); // cue-1 freed
  });

  test("nothing merged → no-op", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-1", "cue-1");
    const rec = (await reconcileSpinoffs(db, () => false));
    expect(rec.merged).toEqual([]);
    expect((await listSpinoffs(db, "launched"))).toHaveLength(1);
    expect((await listAgents(db))).toHaveLength(1);
  });

  test("a squash on origin/main marks a launched row merged without moving local main (932)", async () => {
    const db = freshDb();
    await seedLaunched(db, "922", "922");
    await seedLaunched(db, "918", "918");
    const rec = await reconcileSpinoffs(db, () => false, undefined, () => 0, "", localSpinoffSteps(db), () => [
      { sha: "abc", subject: "fix(ob 922): paint nested rows", body: "" },
      { sha: "def", subject: "chart(ob 911): out of scope", body: "" },
    ]);
    expect(rec.merged).toEqual(["922"]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["918"]);
  });

  test("a done ticket marks a launched row merged; an open ticket stays (932)", async () => {
    const db = freshDb();
    const done = await createItem(db, { type: "task", title: "landed", status: "done" });
    const open = await createItem(db, { type: "task", title: "still open", status: "open" });
    await seedLaunched(db, done, done);
    await seedLaunched(db, open, open);
    const rec = await reconcileSpinoffs(db, () => false, undefined, () => 0, "", localSpinoffSteps(db), () => []);
    // The rows carry the items' refs (1949): enqueue renames a numbered ticket to it.
    expect(rec.merged).toEqual(["OB-1"]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["OB-2"]);
  });

  test("a handed-off row lands when its ticket is done (1596, was: stays, 932)", async () => {
    const db = freshDb();
    const done = await createItem(db, { type: "task", title: "gated", status: "done" });
    const { row } = await enqueueSpinoff(db, input({ ticketRef: done, branch: done }));
    db.query("UPDATE spinoff SET status = 'ready-for-gate', agent_id = ? WHERE id = ?").run(done, row.id);
    const rec = await reconcileSpinoffs(db, () => false, undefined, () => 0, "", localSpinoffSteps(db), () => []);
    expect(rec.merged).toEqual(["OB-1"]);
    expect(await listSpinoffs(db, "ready-for-gate")).toEqual([]);
  });

  test("DEFAULT is now git-state (branch merged into main), NOT a PR check (#36)", async () => {
    const db = freshDb();
    // seed two launched rows in the SAME repo, different branches
    const seedIn = async (repo: string, ticket: string, branch: string) => {
      const { row } = (await enqueueSpinoff(db, input({ ticketRef: ticket, repo, branch })));
      // base_sha as if captured at launch (#61); the merged-set fake below still gates on isMerged first
      db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, base_sha = 'base-sha' WHERE id = ?").run(branch, row.id);
      (await registerAgent(db, { id: branch, ticket, branch, status: "working", ttlS: 900 }));
    };
    await seedIn("/r/omnislash", "36", "36-a");
    await seedIn("/r/omnislash", "37", "37-b");
    // fake the `git branch --merged main` seam: only 36-a is merged into main; rev-list reports commits
    const restore = __setSh((cmd) => {
      if (cmd.includes("branch") && cmd.includes("--merged")) return { ok: true, err: "", out: "main\n36-a\n" };
      if (cmd.includes("rev-list") && cmd.includes("--count")) return { ok: true, err: "", out: "2\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const rec = (await reconcileSpinoffs(db)); // default git-state checker — no isMerged passed
      expect(rec.merged).toEqual(["36"]);
      expect((await listSpinoffs(db, "merged")).map((r) => r.ticket_ref)).toEqual(["36"]);
      expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["37"]);
    } finally {
      restore();
    }
  });

  test("gitMergedChecker: memoises the merged-set per repo (one shell-out per repo per pass)", async () => {
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      if (cmd.includes("--merged")) return { ok: true, err: "", out: "main\nfeat-1\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const check = gitMergedChecker();
      expect(check("/r/x", "feat-1")).toBe(true);
      expect(check("/r/x", "feat-2")).toBe(false);
      expect(check("/r/x", "feat-1")).toBe(true);
      // 3 checks in the same repo → the branch --merged query ran exactly once (memoised)
      expect(calls.filter((c) => c.includes("--merged"))).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("git error → empty merged-set → row not reconciled (graceful, never throws)", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-1", "cue-1");
    const restore = __setSh(() => ({ ok: false, err: "fatal: not a git repository", out: "" }));
    try {
      const rec = (await reconcileSpinoffs(db)); // default git-state; git fails → nothing merged
      expect(rec.merged).toEqual([]);
      expect((await listSpinoffs(db, "launched"))).toHaveLength(1);
    } finally {
      restore();
    }
  });

  // #55: on reconcile, the row's token totals are populated from the injected token reader.
  test("merged row persists the worktree's token totals (#55)", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-1", "cue-1");
    await seedLaunched(db, "CUE-2", "cue-2");
    const usage = { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 1000, totalTokens: 1125 };
    const rec = (await reconcileSpinoffs(db, (_repo, branch) => branch === "cue-1", () => usage, () => 1));
    expect(rec.merged).toEqual(["CUE-1"]);
    const merged = (await listSpinoffs(db, "merged")).find((r) => r.ticket_ref === "CUE-1")!;
    expect(merged.input_tokens).toBe(100);
    expect(merged.output_tokens).toBe(20);
    expect(merged.cache_creation_tokens).toBe(5);
    expect(merged.cache_read_tokens).toBe(1000);
    expect(merged.total_tokens).toBe(1125);
    // the un-merged row is untouched (still default 0)
    const launched = (await listSpinoffs(db, "launched")).find((r) => r.ticket_ref === "CUE-2")!;
    expect(launched.total_tokens).toBe(0);
  });
});

describe("reconcile base_sha gate (#60, folded into #61)", () => {
  const seedWithBase = async (db: ReturnType<typeof freshDb>, ticket: string, branch: string, baseSha: string | null) => {
    const { row } = (await enqueueSpinoff(db, input({ ticketRef: ticket, branch })));
    db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, base_sha = ? WHERE id = ?").run(branch, baseSha, row.id);
    (await registerAgent(db, { id: branch, ticket, branch, status: "working", ttlS: 900 }));
    return row.id;
  };

  test("gitUniqueCommitCount: a NULL base_sha with no branch reflog is a safe fallback, 0 (OB-1921)", async () => {
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      return { ok: false, err: "fatal: no reflog", out: "" };
    });
    try {
      expect(gitUniqueCommitCount()("/r/x", null, "some-branch")).toBe(0);
    } finally {
      restore();
    }
    // only the reflog was asked; with no fork point there is nothing to count against
    expect(calls).toEqual([["git", "-C", "/r/x", "reflog", "show", "--format=%H", "refs/heads/some-branch", "--"]]);
  });

  test("gitUniqueCommitCount: a NULL base_sha counts from the branch's reflog creation point (OB-1921)", async () => {
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      if (cmd[3] === "reflog") return { ok: true, err: "", out: "c3\nc2\nc1fork\n" };
      if (cmd.at(-1) === "feat-1^{commit}") return { ok: true, err: "", out: "tip1\n" };
      return { ok: true, err: "", out: cmd.includes("--count") ? "2\n" : "" };
    });
    try {
      expect(gitUniqueCommitCount()("/r/x", null, "feat-1")).toBe(2);
    } finally {
      restore();
    }
    expect(calls[1]).toEqual(["git", "-C", "/r/x", "rev-list", "--count", "c1fork..feat-1"]);
    // OB-2180: then the tip is checked against main's first-parent line from the same fork point
    expect(calls.at(-1)).toEqual(["git", "-C", "/r/x", "rev-list", "--first-parent", "c1fork..main"]);
  });

  test("gitUniqueCommitCount: counts via `git rev-list --count <base>..<branch>`", async () => {
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      if (cmd.at(-1) === "feat-1^{commit}") return { ok: true, err: "", out: "tip1\n" };
      return { ok: true, err: "", out: cmd.includes("--count") ? "3\n" : "" };
    });
    try {
      expect(gitUniqueCommitCount()("/r/x", "deadbeef", "feat-1")).toBe(3);
    } finally {
      restore();
    }
    // OB-2180: the count, then the tip, then main's first-parent line (via the main-ref read)
    expect(calls[0]).toEqual(["git", "-C", "/r/x", "rev-list", "--count", "deadbeef..feat-1"]);
    expect(calls[1]).toEqual(["git", "-C", "/r/x", "rev-parse", "--verify", "--quiet", "feat-1^{commit}"]);
    expect(calls.at(-1)).toEqual(["git", "-C", "/r/x", "rev-list", "--first-parent", "deadbeef..main"]);
  });

  test("gitUniqueCommitCount: a tip on main's line with no reflog keeps its count (OB-2180; real-repo cases are in reconcile-rebased-branch-2180)", async () => {
    const restore = __setSh((cmd) => {
      if (cmd.includes("--count")) return { ok: true, err: "", out: "2\n" };
      if (cmd.includes("rev-parse") && cmd.at(-1) === "feat-1^{commit}") return { ok: true, err: "", out: "f9c1\n" };
      if (cmd.includes("--first-parent")) return { ok: true, err: "", out: "f9c1\nec50\n" };
      if (cmd.includes("--format=%gs")) return { ok: true, err: "", out: "" };
      return { ok: false, err: "", out: "" };
    });
    try {
      expect(gitUniqueCommitCount()("/r/x", "b0da", "feat-1")).toBe(2);
    } finally {
      restore();
    }
  });

  test("gitUniqueCommitCount: a git error is graceful, 0, never throws", async () => {
    const restore = __setSh(() => ({ ok: false, err: "fatal: bad revision", out: "" }));
    try {
      expect(gitUniqueCommitCount()("/r/x", "deadbeef", "feat-1")).toBe(0);
    } finally {
      restore();
    }
  });

  test("a branch merged into main with ZERO unique commits past its base is NOT marked done (#60, the exact bug)", async () => {
    const db = freshDb();
    await seedWithBase(db, "60", "60-fresh", "deadbeef");
    // isMerged says yes (trivially true for a just-launched branch, the original bug); 0 unique commits
    const rec = (await reconcileSpinoffs(db, () => true, undefined, () => 0));
    expect(rec.merged).toEqual([]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["60"]);
    expect((await listAgents(db))).toHaveLength(1); // no slot freed - it never completed
  });

  test("an adopted branch that already carries commits, merged into main, IS marked done", async () => {
    const db = freshDb();
    await seedWithBase(db, "61", "61-adopted", "deadbeef"); // base captured at adoption time (may itself be ahead of main)
    const rec = (await reconcileSpinoffs(db, () => true, undefined, () => 4)); // 4 commits past the captured base
    expect(rec.merged).toEqual(["61"]);
    expect((await listSpinoffs(db, "merged")).map((r) => r.ticket_ref)).toEqual(["61"]);
  });

  test("unique commits present but NOT yet merged into main stays launched", async () => {
    const db = freshDb();
    await seedWithBase(db, "62", "62-wip", "deadbeef");
    const rec = (await reconcileSpinoffs(db, () => false, undefined, () => 2)); // has work, but not merged
    expect(rec.merged).toEqual([]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["62"]);
  });

  test("a NULL base_sha (a row launched before #61) is never auto-marked merged via this gate", async () => {
    const db = freshDb();
    await seedWithBase(db, "63", "63-legacy", null);
    // isMerged forced true; the DEFAULT countUnique is used (no override): null base_sha short-circuits
    // to 0 without shelling out, so this never reaches a real `git rev-list` call either.
    const rec = (await reconcileSpinoffs(db, () => true));
    expect(rec.merged).toEqual([]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["63"]);
  });
});

describe("watch: transition detection + report (#36)", () => {
  const seedLaunched = async (db: ReturnType<typeof freshDb>, ticket: string, branch: string) => {
    const { row } = (await enqueueSpinoff(db, input({ ticketRef: ticket, branch })));
    // base_sha set as if captured at launch (#61); watchReconcileTick uses reconcileSpinoffs' DEFAULT
    // countUnique, so a real (mocked) rev-list count is needed for these merge-detection tests.
    db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, base_sha = 'base-sha' WHERE id = ?").run(branch, row.id);
    (await registerAgent(db, { id: branch, ticket, branch, status: "working", ttlS: 900 }));
  };
  const noEmit = () => {};
  const reportedAt = (db: ReturnType<typeof freshDb>, ticket: string) =>
    (db.query("SELECT reported_at FROM spinoff WHERE ticket_ref = ?").get(ticket) as { reported_at: string | null }).reported_at;

  test("watchReconcileTick reports a newly-done spinoff once; later ticks don't re-report it", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-1", "cue-1");
    await seedLaunched(db, "CUE-2", "cue-2");
    const state: SpinoffWatchState = { reported: new Set() };
    // rev-list (the default countUnique) reports commits present for every branch here; these tests
    // are about transition detection, not the #60/#61 unique-commit gate itself.
    const restore = __setSh((cmd) => {
      if (cmd.includes("rev-list") && cmd.includes("--count")) return { ok: true, err: "", out: "1\n" };
      return { ok: true, err: "", out: "" };
    });

    try {
      // tick 1: only cue-1 merged → reported once
      let done = (await watchReconcileTick(db, state, noEmit, (_repo, b) => b === "cue-1"));
      expect(done.map((d) => d.ticket_ref)).toEqual(["CUE-1"]);
      expect(done[0]!.branch).toBe("cue-1");
      expect(done[0]!.outcome).toBe("landed on main");

      // tick 2: cue-1 still merged (already reported) + cue-2 now merged → only cue-2 is NEW
      done = (await watchReconcileTick(db, state, noEmit, () => true));
      expect(done.map((d) => d.ticket_ref)).toEqual(["CUE-2"]);

      // tick 3: nothing new → empty
      expect((await watchReconcileTick(db, state, noEmit, () => true))).toEqual([]);
    } finally {
      restore();
    }
  });

  test("watchReconcileTick reports already-done-but-unreported rows on the first tick", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-1", "cue-1");
    // pre-mark it merged (as if reconciled before watch started)
    db.query("UPDATE spinoff SET status = 'merged' WHERE ticket_ref = 'CUE-1'").run();
    const done = (await watchReconcileTick(db, { reported: new Set() }, noEmit, () => false));
    expect(done.map((d) => d.ticket_ref)).toEqual(["CUE-1"]);
  });

  // #41: the backlog problem. reportedness lives on the row (`reported_at`), not in a per-process Set,
  // so a fresh watch process starts from the persisted truth instead of replaying every historical
  // `merged` row (which made `--once` exit before the spinoff being waited on had even started).
  test("a merged row already stamped reported_at emits nothing, even on a fresh state object", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-OLD", "cue-old");
    db.query("UPDATE spinoff SET status = 'merged', reported_at = '2026-07-01T00:00:00.000Z' WHERE ticket_ref = 'CUE-OLD'").run();
    expect((await watchReconcileTick(db, { reported: new Set() }, noEmit, () => false))).toEqual([]);
  });

  test("a newly-merged row is emitted once, and a BRAND-NEW state object does not re-emit it", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-NEW", "cue-new");
    const restore = __setSh((cmd) => {
      if (cmd.includes("rev-list") && cmd.includes("--count")) return { ok: true, err: "", out: "1\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const first = (await watchReconcileTick(db, { reported: new Set() }, noEmit, () => true));
      expect(first.map((d) => d.ticket_ref)).toEqual(["CUE-NEW"]);
      // the emit stamped the row, so a second process (a fresh state) sees nothing new
      expect((await watchReconcileTick(db, { reported: new Set() }, noEmit, () => true))).toEqual([]);
      expect((await listSpinoffs(db, "merged"))[0]!.reported_at).not.toBeNull();
    } finally {
      restore();
    }
  });

  // 74: the print IS the announcement, so it has to happen BEFORE the row is stamped reported. Stamping
  // first left a window where a crash lost the completion for good: reported_at non-null, so no later
  // tick and no later process would ever emit it, and the architect was never told the spinoff finished.
  test("a newly-merged row whose emit THROWS keeps reported_at NULL and is re-emitted on a later tick", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-BOOM", "cue-boom");
    const restore = __setSh((cmd) => {
      if (cmd.includes("rev-list") && cmd.includes("--count")) return { ok: true, err: "", out: "1\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const state: SpinoffWatchState = { reported: new Set() };
      const failed = (await watchReconcileTick(
        db,
        state,
        () => {
          throw new Error("stdout gone");
        },
        () => true,
      ));
      expect(failed).toEqual([]); // never announced, so never counted as reported
      expect(reportedAt(db, "CUE-BOOM")).toBeNull();

      // the SAME process's next tick still delivers it (the in-memory fast path is not poisoned either)
      const seen: string[] = [];
      const retry = (await watchReconcileTick(db, state, (d) => seen.push(d.ticket_ref), () => true));
      expect(seen).toEqual(["CUE-BOOM"]);
      expect(retry.map((d) => d.ticket_ref)).toEqual(["CUE-BOOM"]);
      expect(reportedAt(db, "CUE-BOOM")).not.toBeNull();
    } finally {
      restore();
    }
  });

  test("emit runs BEFORE reported_at is stamped (print-then-stamp, observed from inside the callback)", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-ORDER", "cue-order");
    const restore = __setSh((cmd) => {
      if (cmd.includes("rev-list") && cmd.includes("--count")) return { ok: true, err: "", out: "1\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      let stampDuringEmit: string | null = "never-emitted";
      const done = (await watchReconcileTick(
        db,
        { reported: new Set() },
        () => {
          stampDuringEmit = reportedAt(db, "CUE-ORDER");
        },
        () => true,
      ));
      expect(done.map((d) => d.ticket_ref)).toEqual(["CUE-ORDER"]);
      expect(stampDuringEmit).toBeNull(); // still unstamped while being announced
      expect(reportedAt(db, "CUE-ORDER")).not.toBeNull(); // stamped only after the announcement returned
    } finally {
      restore();
    }
  });

  test("one row whose emit throws does not stop the OTHER rows in the same tick", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-OK1", "cue-ok1");
    await seedLaunched(db, "CUE-BAD", "cue-bad");
    await seedLaunched(db, "CUE-OK2", "cue-ok2");
    const restore = __setSh((cmd) => {
      if (cmd.includes("rev-list") && cmd.includes("--count")) return { ok: true, err: "", out: "1\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const seen: string[] = [];
      const done = (await watchReconcileTick(
        db,
        { reported: new Set() },
        (d) => {
          seen.push(d.ticket_ref);
          if (d.ticket_ref === "CUE-BAD") throw new Error("print failed");
        },
        () => true,
      ));
      expect(seen).toEqual(["CUE-OK2", "CUE-BAD", "CUE-OK1"]); // newest first, and the failure is not fatal
      expect(done.map((d) => d.ticket_ref)).toEqual(["CUE-OK2", "CUE-OK1"]);
      expect(reportedAt(db, "CUE-OK2")).not.toBeNull();
      expect(reportedAt(db, "CUE-OK1")).not.toBeNull();
      expect(reportedAt(db, "CUE-BAD")).toBeNull(); // still owed a report
    } finally {
      restore();
    }
  });

  test("a launched row whose branch is not merged emits nothing", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-WIP", "cue-wip");
    expect((await watchReconcileTick(db, { reported: new Set() }, noEmit, () => false))).toEqual([]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["CUE-WIP"]);
  });

  test("a completion reconciled by ANOTHER process is still emitted once by watch", async () => {
    const db = freshDb();
    await seedLaunched(db, "CUE-OTHER", "cue-other");
    const restore = __setSh((cmd) => {
      if (cmd.includes("rev-list") && cmd.includes("--count")) return { ok: true, err: "", out: "1\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      // stand-in for `ob spinoff reconcile` / `ob spinoff drain` winning the transition
      expect((await reconcileSpinoffs(db, () => true)).merged).toEqual(["CUE-OTHER"]);
      expect((await watchReconcileTick(db, { reported: new Set() }, noEmit, () => true)).map((d) => d.ticket_ref)).toEqual(["CUE-OTHER"]);
      expect((await watchReconcileTick(db, { reported: new Set() }, noEmit, () => true))).toEqual([]);
    } finally {
      restore();
    }
  });

  test("watchSpinoffs --once returns after an already-done row on start (no watcher needed)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const { row } = (await enqueueSpinoff(db, input({ ticketRef: "CUE-9", branch: "cue-9" })));
    db.query("UPDATE spinoff SET status = 'launched', agent_id = 'cue-9', base_sha = 'base-sha' WHERE id = ?").run(row.id);
    (await registerAgent(db, { id: "cue-9", ticket: "CUE-9", branch: "cue-9", status: "working", ttlS: 900 }));
    // inject an isMerged that says cue-9 is done; rev-list (default countUnique) reports commits present
    const restore = __setSh((cmd) => {
      if (cmd.includes("rev-list") && cmd.includes("--count")) return { ok: true, err: "", out: "1\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      await watchSpinoffs(db, dbPath, { once: true, isMerged: () => true });
      expect((await listSpinoffs(db, "merged")).map((r) => r.ticket_ref)).toEqual(["CUE-9"]);
    } finally {
      restore();
      db.close();
    }
  });

  test("formatDoneSpinoff renders ticket · branch · outcome", async () => {
    expect(formatDoneSpinoff({ id: 1, ticket_ref: "CUE-1", branch: "cue-1", outcome: "merged into main" })).toBe(
      "✓ CUE-1 · cue-1 · merged into main",
    );
  });

  test("recentlyDoneSpinoffs returns merged rows newest-first, capped", async () => {
    const db = freshDb();
    for (const [t, b] of [["A", "a"], ["B", "b"], ["C", "c"]] as const) {
      const { row } = (await enqueueSpinoff(db, input({ ticketRef: t, branch: b })));
      db.query("UPDATE spinoff SET status = 'merged' WHERE id = ?").run(row.id);
    }
    const recent = (await recentlyDoneSpinoffs(db));
    expect(recent.map((r) => r.ticket_ref)).toEqual(["C", "B", "A"]); // id desc
    expect((await recentlyDoneSpinoffs(db, 2)).map((r) => r.ticket_ref)).toEqual(["C", "B"]); // capped
  });
});

describe("launcher seam (154/G5)", () => {
  test("spinoff_launcher defaults to t3; t3 is the only routable name (ob 1109, 1120, 1589)", async () => {
    expect(setting(freshDb(), "spinoff_launcher")).toBe("t3");
    expect(DEFAULT_LAUNCHER).toBe("t3");
    expect(LAUNCHER_NAMES).toEqual(["t3"]);
    // headless (1589) and warp (#79) are legacy: rows that recorded them still read, nothing routes to them
    expect(isLauncherName("t3")).toBe(true);
    for (const legacy of ["headless", "warp"]) {
      expect(isLauncherName(legacy)).toBe(false);
      expect(isLegacyLauncherName(legacy)).toBe(true);
    }
  });

  // The DEFAULTS drift #141 caught in the *_agent_cmd settings is the same shape a launcher default can
  // rot into. So the default is asserted to be ROUTABLE rather than to be a particular string.
  test("the shipped launcher defaults name a routable launcher, never a removed one (#79/#141)", async () => {
    const shipped = DEFAULTS.spinoff_launcher!;
    expect(isLauncherName(shipped), `spinoff_launcher default '${shipped}' is not a routable launcher`).toBe(true);
    expect(isLegacyLauncherName(shipped), `spinoff_launcher default '${shipped}' is a removed launcher`).toBe(false);
    const byRepo = JSON.parse(DEFAULTS.spinoff_launcher_by_repo!) as Record<string, string>;
    for (const [repo, name] of Object.entries(byRepo)) {
      expect(isLauncherName(name), `spinoff_launcher_by_repo['${repo}'] = '${name}' is not a routable launcher`).toBe(true);
    }
  });

  test("selectLauncherName always resolves t3; an unknown or legacy stored value falls back, never resurrects", async () => {
    const db = freshDb();
    expect(selectLauncherName(db)).toBe("t3");
    // a value stored before 1589 (config set now refuses one) falls back rather than resurrecting a launcher
    for (const value of ["bogus", "warp", "headless"]) {
      db.query("INSERT OR REPLACE INTO config (key, value) VALUES ('spinoff_launcher', ?)").run(value);
      expect(selectLauncherName(db)).toBe("t3");
    }
  });

  test("config set spinoff_launcher refuses headless and unknown values, naming t3 (1589)", async () => {
    const dbPath = freshDbPath();
    for (const value of ["headless", "warp", "bogus"]) {
      const res = await runCli(dbPath, ["config", "set", "spinoff_launcher", value]);
      expect(res.code).toBe(2);
      expect(res.err).toContain("must be one of t3");
    }
    const legacy = await runCli(dbPath, ["config", "set", "spinoff_launcher", "headless"]);
    expect(legacy.err).toContain("ob 1589 removed headless");
    const byRepo = await runCli(dbPath, ["config", "set", "spinoff_launcher_by_repo", JSON.stringify({ omnislash: "headless" })]);
    expect(byRepo.code).toBe(2);
    expect(byRepo.err).toContain("spinoff_launcher_by_repo[omnislash] must be one of t3");
    expect((await runCli(dbPath, ["config", "set", "spinoff_launcher", "t3"])).code).toBe(0);
    expect((await runCli(dbPath, ["config", "set", "spinoff_launcher_by_repo", JSON.stringify({ omnislash: "t3" })])).code).toBe(0);
    expect(setting(openDb(dbPath), "spinoff_launcher")).toBe("t3");
  });

  describe("spinoff_launcher_by_repo (#83): the map survives, a retired value falls back", () => {
    test("defaults to '{}' — empty map, the global launcher wins for every repo", async () => {
      const db = freshDb();
      expect(setting(db, "spinoff_launcher_by_repo")).toBe("{}");
      expect(selectLauncherName(db, "/r/omnislash")).toBe("t3");
      expect(selectLauncherName(db, "/r/cue-frontend")).toBe("t3");
    });

    test("an entry naming a routable launcher is honoured; one naming a retired value falls back", async () => {
      const db = freshDb();
      db.query("INSERT OR REPLACE INTO config (key, value) VALUES ('spinoff_launcher_by_repo', ?)").run(
        JSON.stringify({ omnislash: "t3", "cue-frontend": "headless" }),
      );
      expect(selectLauncherName(db, "/Users/j/dev/omnislash")).toBe("t3");
      // keyed by basename — works whether repo is a bare local path or an org/slug ending in the same name
      expect(selectLauncherName(db, "omnislash")).toBe("t3");
      expect(selectLauncherName(db, "/Users/j/dev/cue-frontend")).toBe("t3");
    });

    test("a malformed spinoff_launcher_by_repo (not JSON, or not an object) is treated as empty — global for all", async () => {
      const db = freshDb();
      for (const value of ["not json", '["omnislash"]']) {
        db.query("INSERT OR REPLACE INTO config (key, value) VALUES ('spinoff_launcher_by_repo', ?)").run(value);
        expect(selectLauncherName(db, "/r/omnislash")).toBe("t3");
      }
    });
  });

  // #125: the resolved launcher is PERSISTED at launch, on the spinoff row and the agent registry row.
  // Re-deriving it later would describe today's config instead of where the agent actually went.
  describe("launcher tracking (#125): the resolved launcher is stamped, never re-derived", () => {
    test("drain stamps the launcher on BOTH the spinoff row and the agent it registers", async () => {
      const db = freshDb();
      const dir = mkdtempSync(join(tmpdir(), "ob-spin-launcher-"));
      const repo = join(dir, "omnislash");
      const branch = "125-stamp";
      (await enqueueSpinoff(db, input({ ticketRef: "125", repo, branch })));
      try {
        await drainWithFakeT3(db, [{ repo, branch }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      expect((await listSpinoffs(db, "launched")).map((s) => s.launcher)).toEqual(["t3"]);
      expect((await listAgents(db)).map((a) => a.launcher)).toEqual(["t3"]);
    });

    test("a row that FAILS to launch still records where it was headed", async () => {
      const db = freshDb();
      const dir = mkdtempSync(join(tmpdir(), "ob-spin-launcher-fail-"));
      const repo = join(dir, "omnislash");
      const branch = "125-fail";
      mkdirSync(worktreePath(repo, branch), { recursive: true });
      (await enqueueSpinoff(db, input({ ticketRef: "125c", repo, branch })));
      const t3 = installFakeT3([]); // T3 is up but has no project for this repo: a named launch failure
      try {
        (await drainSpinoffs(db));
      } finally {
        t3.restore();
        rmSync(dir, { recursive: true, force: true });
      }
      const failed = (await listSpinoffs(db, "failed"));
      expect(failed.map((s) => s.ticket_ref)).toEqual(["125c"]);
      expect(failed[0]!.launcher).toBe("t3");
    });

    test("spinoff list still renders a legacy headless or warp row as what it recorded (#79, 1589)", async () => {
      const dbPath = freshDbPath();
      const db = openDb(dbPath);
      for (const [ref, legacy] of [["79f", "warp"], ["1589h", "headless"]] as const) {
        const { row } = (await enqueueSpinoff(db, input({ ticketRef: ref, branch: `${ref}-legacy` })));
        db.query("UPDATE spinoff SET status = 'launched', launcher = ? WHERE id = ?").run(legacy, row.id);
      }
      db.close();

      const res = await runCli(dbPath, ["spinoff", "list"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("79f-legacy\twarp\t"); // labelled as what it actually was
      expect(res.out).toContain("1589h-legacy\theadless\t");
      const j = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
      expect(j.map((r) => r.launcher).sort(byCodeUnit)).toEqual(["headless", "warp"]);
    });

    test("spinoff list renders '-' for a row launched before the launcher was recorded", async () => {
      const dbPath = freshDbPath();
      const db = openDb(dbPath);
      const { row } = (await enqueueSpinoff(db, input({ ticketRef: "125e", branch: "125-legacy" })));
      db.query("UPDATE spinoff SET status = 'launched' WHERE id = ?").run(row.id); // launcher stays NULL
      db.close();
      const res = await runCli(dbPath, ["spinoff", "list"]);
      expect(res.out).toContain("125-legacy\t-\t");
      const j = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out);
      expect(j[0].launcher).toBeNull();
    });
  });

  describe("spinoff show is inspect, never enqueue", () => {
    test("show is not an enqueue subcommand", () => {
      expect(isSpinoffEnqueue("spinoff", ["show"])).toBe(false);
      expect(isSpinoffEnqueue("spinoff", ["show", "283"])).toBe(false);
      expect(isSpinoffEnqueue("spinoff", ["283"])).toBe(true);
    });

    test("pickSpinoffForShow: numeric id wins, else newest ticket, else branch", () => {
      const older = rowOf({ id: 1, ticket_ref: "T", branch: "t" });
      const newer = rowOf({ id: 10, ticket_ref: "T", branch: "t-new" });
      const other = rowOf({ id: 7, ticket_ref: "U", branch: "u" });
      const all = [newer, other, older];
      expect(pickSpinoffForShow(all, "7").id).toBe(7);
      expect(pickSpinoffForShow(all, "T").id).toBe(10);
      expect(pickSpinoffForShow(all, "u").id).toBe(7);
    });

    test("ob spinoff show prints a row and does not enqueue", async () => {
      const dbPath = freshDbPath();
      const db = openDb(dbPath);
      const { row } = await enqueueSpinoff(db, input({ ticketRef: "show-ticket", branch: "show-branch", brief: "THE BRIEF" }));
      db.close();

      const before = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
      const res = await runCli(dbPath, ["spinoff", "show", "show-ticket"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("THE BRIEF");
      expect(res.out).toContain("show-ticket");
      expect(res.out).not.toContain("the daemon launches it");
      const after = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
      expect(after).toHaveLength(before.length);

      const byId = await runCli(dbPath, ["spinoff", "show", String(row.id), "--json"]);
      expect(JSON.parse(byId.out).id).toBe(row.id);
      expect(JSON.parse(byId.out).brief).toBe("THE BRIEF");

      const missing = await runCli(dbPath, ["spinoff", "show", "no-such"]);
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("no spinoff matching");
      expect(JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out)).toHaveLength(before.length);
    });

    test("ob spinoff show with no ref is usage, not an enqueue of ticket 'show'", async () => {
      const dbPath = freshDbPath();
      const usage = await runCli(dbPath, ["spinoff", "show"]);
      expect(usage.code).toBe(2);
      expect(usage.err).toContain("spinoff show requires a <ticket|id>");
      const listed = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
      expect(listed).toEqual([]);
    });
  });

  // #55: the list surfaces a compact per-spinoff token total.
  test("spinoff list renders the per-spinoff token total (#55)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const { row } = (await enqueueSpinoff(db, input({ ticketRef: "55", branch: "55-tok" })));
    db.query("UPDATE spinoff SET status = 'merged', total_tokens = 106500 WHERE id = ?").run(row.id);
    const res = await runCli(dbPath, ["spinoff", "list"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("106.5k tok");
    // JSON mode carries the raw totals
    const j = await runCli(dbPath, ["spinoff", "list", "--json"]);
    expect(JSON.parse(j.out).find((r: { branch: string }) => r.branch === "55-tok").total_tokens).toBe(106500);
  });
});

describe("process table (former liveness probe, #121/#138)", () => {
  test("probeArgv reads the whole process table with `ps`, never `pgrep` (#121)", () => {
    expect(probeArgv()[0]).toBe("ps");
    expect(probeArgv()).toContain("-A");
    expect(probeArgv().join(" ")).not.toContain("pgrep");
  });

  test("parseProcessTable: pid plus argv[0], and argv[0] may contain spaces", () => {
    const rows = parseProcessTable("    1 /sbin/launchd\n 4321 /Applications/Some App.app/Contents/MacOS/Some App\ngarbage\n");
    expect(rows).toEqual([
      { pid: 1, comm: "/sbin/launchd" },
      { pid: 4321, comm: "/Applications/Some App.app/Contents/MacOS/Some App" },
    ]);
  });

  test("processTableSawSelf: a table without the asker in it is not evidence about anything (#121)", () => {
    const rows = parseProcessTable("  1 /sbin/launchd\n");
    expect(processTableSawSelf(rows, 999)).toBe(false);
    expect(processTableSawSelf([...rows, { pid: 999, comm: "/x/ob" }], 999)).toBe(true);
  });

  test("processUsingPath: three answers — running / clear / unknown; sibling prefix is not a match (ob 138)", () => {
    const wt = mkdtempSync(join(tmpdir(), "ob-procuse-"));
    const rows = [
      { pid: 1, comm: "/bin/sh" },
      { pid: 2, comm: join(wt, "node") },
    ];
    try {
      expect(processUsingPath(rows, wt)).toEqual({ kind: "running", pid: 2, comm: join(wt, "node") });
      expect(processUsingPath(rows, `${wt}-sibling`)).toEqual({ kind: "clear" });
      expect(processUsingPath(rows, "")).toEqual({ kind: "clear" });
      expect(processUsingPath(null, wt)).toEqual({ kind: "unknown" });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("launch persists base_sha + worktree adoption onto the row (#61)", () => {
  test("captures base_sha (git merge-base branch main) at launch and persists it", async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "ob-spin-basesha-"));
    const repo = join(dir, "omnislash");
    const branch = "61-fresh";
    const worktree = worktreePath(repo, branch);
    mkdirSync(worktree, { recursive: true }); // pre-exists → ensureWorktree is a no-op (no `list`/`add` calls)
    (await enqueueSpinoff(db, input({ ticketRef: "61", repo, branch, brief: "B" })));

    const t3 = installFakeT3([repo]);
    const restoreSh = __setSh((cmd) => {
      if (cmd.includes("merge-base")) return { ok: true, err: "", out: "deadbeef1234\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      (await drainSpinoffs(db));
    } finally {
      restoreSh();
      t3.restore();
      rmSync(dir, { recursive: true, force: true });
    }
    const row = (await listSpinoffs(db, "launched")).find((r) => r.ticket_ref === "61")!;
    expect(row.base_sha).toBe("deadbeef1234");
    expect(row.worktree).toBe(worktree); // unchanged, nothing to adopt
  });

  test("adopting an existing worktree elsewhere persists the resolved path onto the row", async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "ob-spin-adopt-"));
    const repo = join(dir, "repo");
    const branch = "61-adopt";
    const elsewhere = join(dir, "elsewhere-checkout");
    (await enqueueSpinoff(db, input({ ticketRef: "61b", repo, branch, brief: "B" })));

    const t3 = installFakeT3([repo]);
    const restoreSh = __setSh((cmd) => {
      if (cmd.includes("list")) return { ok: true, err: "", out: `worktree ${elsewhere}\nHEAD deadbeef\nbranch refs/heads/${branch}\n` };
      if (cmd.includes("merge-base")) return { ok: true, err: "", out: "abc123\n" };
      return { ok: true, err: "", out: "" };
    });
    let r: Awaited<ReturnType<typeof drainSpinoffs>>;
    try {
      r = (await drainSpinoffs(db));
    } finally {
      restoreSh();
      t3.restore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(r.launched).toEqual(["61b"]);
    const row = (await listSpinoffs(db, "launched")).find((row) => row.ticket_ref === "61b")!;
    expect(row.worktree).toBe(elsewhere); // adopted, not the derived <repo>.<branch> path
    expect(row.base_sha).toBe("abc123");
  });
});

describe("ensureWorktree — git-driven, no `wt` dependency (160)", () => {
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), "ob-ensurewt-"));
    const repo = join(base, "repo");
    const branch = "160-x";
    const wt = worktreePath(repo, branch);
    const row = rowOf({ repo, branch, worktree: wt });
    return { base, repo, branch, wt, row };
  };

  test("issues `git worktree add <repo>.<branch> -b <branch> main` (NEVER wt) at the convention path", async () => {
    const { base, repo, branch, wt, row } = setup();
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      if (cmd.includes("list")) return { ok: true, err: "", out: "" }; // no adoption candidate (#61)
      mkdirSync(wt, { recursive: true }); // simulate git creating the worktree
      return { ok: true, err: "" };
    });
    let resolved: string;
    try {
      resolved = ensureWorktree(row);
    } finally {
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(resolved).toBe(wt);
    expect(calls).toHaveLength(5); // (#61) list first (adoption candidate), (1490) origin check + fetch + origin/main read, then add
    expect(calls.every((c) => c[0] === "git")).toBe(true); // a real binary, never the `wt` shell function
    expect(calls.some((c) => c.includes("wt"))).toBe(false);
    expect(calls[0]).toEqual(["git", "-C", repo, "worktree", "list", "--porcelain"]);
    expect(calls[1]).toEqual(["git", "-C", repo, "remote", "get-url", "origin"]);
    expect(calls[2]).toEqual(["git", "-C", repo, "fetch", "--quiet", "origin", "main"]);
    expect(calls[3].slice(0, 5)).toEqual(["git", "-C", repo, "rev-parse", "--verify"]);
    expect(calls[4]).toEqual(["git", "-C", repo, "worktree", "add", wt, "-b", branch, "main"]); // no origin/main in this repo: local main
  });

  test("no-op when the worktree already exists (no shell-out at all)", async () => {
    const { base, wt, row } = setup();
    mkdirSync(wt, { recursive: true });
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      return { ok: true, err: "" };
    });
    let resolved: string;
    try {
      resolved = ensureWorktree(row);
    } finally {
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(resolved).toBe(wt);
    expect(calls).toHaveLength(0);
  });

  test("falls back to attaching an existing branch when `-b` fails", async () => {
    const { base, repo, branch, wt, row } = setup();
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      if (cmd.includes("list")) return { ok: true, err: "", out: "" }; // no adoption candidate (#61)
      if (!cmd.includes("add")) return { ok: true, err: "", out: "" }; // (1490) the fetch and the origin/main read
      if (cmd.includes("-b")) return { ok: false, err: "fatal: a branch named '160-x' already exists" };
      mkdirSync(wt, { recursive: true }); // the fallback (attach existing branch) creates it
      return { ok: true, err: "" };
    });
    try {
      ensureWorktree(row);
    } finally {
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(calls).toHaveLength(6);
    expect(calls[0]).toEqual(["git", "-C", repo, "worktree", "list", "--porcelain"]);
    expect(calls[4]).toEqual(["git", "-C", repo, "worktree", "add", wt, "-b", branch, "main"]);
    expect(calls[5]).toEqual(["git", "-C", repo, "worktree", "add", wt, branch]); // fallback: no `-b`, no base
    expect(calls.every((c) => c[0] === "git")).toBe(true);
  });

  test("a `git worktree add` that fails with empty stderr names the command and its exit code (OB-2145)", async () => {
    const { base, repo, wt, row } = setup();
    const restore = __setSh((cmd) => {
      if (cmd.includes("list")) return { ok: true, err: "", out: "" };
      if (cmd.includes("add")) return { ok: false, err: "", out: "", code: 128, signal: null };
      return { ok: true, err: "", out: "" };
    });
    try {
      let msg = "";
      try {
        ensureWorktree(row);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain(`\`git -C ${repo} worktree add ${wt} 160-x\``); // the fallback, the last command run
      expect(msg).toContain("exit 128");
      expect(msg).not.toContain("git worktree error");
    } finally {
      restore();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an add that reports success but leaves no worktree says so, and a killed git names its signal (OB-2145)", async () => {
    const { base, wt, row } = setup();
    let restore = __setSh((cmd) => (cmd.includes("add") ? { ok: true, err: "", out: "", code: 0, signal: null } : { ok: true, err: "", out: "" }));
    try {
      expect(() => ensureWorktree(row)).toThrow(`worktree add ${wt} -b 160-x main\` wrote nothing to stderr (exit 0, reported success)`);
      restore();
      restore = __setSh((cmd) => (cmd.includes("add") ? { ok: false, err: "", out: "", code: null, signal: "SIGKILL" } : { ok: true, err: "", out: "" }));
      expect(() => ensureWorktree(row)).toThrow("(killed by SIGKILL)");
    } finally {
      restore();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("throws a clear AppError when the worktree is still absent after the attempt", async () => {
    const { base, row } = setup();
    const restore = __setSh(() => ({ ok: false, err: "fatal: not a git repository" }));
    try {
      expect(() => ensureWorktree(row)).toThrow(/worktree create failed: fatal: not a git repository/);
    } finally {
      restore();
      rmSync(base, { recursive: true, force: true });
    }
  });

  // --- 1490: the base is origin/main as of NOW, not the local main ref ---------------------------------

  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
    return new TextDecoder().decode(p.stdout).trim();
  };

  /** origin (bare) <- clone (the repo checkout, local main stale) , with `landings` commits pushed by a third clone. */
  const staleMainRepo = (landings: number) => {
    const base = mkdtempSync(join(tmpdir(), "ob-base1490-"));
    const origin = join(base, "origin.git");
    git(base, "init", "--bare", "-b", "main", origin);
    const repo = join(base, "repo");
    git(base, "clone", origin, repo);
    git(repo, "checkout", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");
    git(repo, "push", "origin", "main");
    const staleSha = git(repo, "rev-parse", "main");
    // lands push from their own worktree: the checkout's local main never moves
    const lander = join(base, "land");
    git(base, "clone", origin, lander);
    for (let i = 0; i < landings; i++) {
      writeFileSync(join(lander, `l${i}.txt`), String(i));
      git(lander, "add", "-A");
      git(lander, "commit", "-m", `feat: landing ${i}\n\nState: landable — landing ${i}`);
    }
    git(lander, "push", "origin", "main");
    return { base, repo, staleSha, originSha: git(lander, "rev-parse", "HEAD") };
  };

  test("a stale local main does not set the base: the new worktree starts at origin/main, fetched (1490)", async () => {
    const { base, repo, staleSha, originSha } = staleMainRepo(3);
    try {
      expect(git(repo, "rev-parse", "main")).toBe(staleSha); // local main is 3 behind...
      expect(git(repo, "rev-parse", "origin/main")).toBe(staleSha); // ...and so is the remote-tracking ref, until the launch fetches
      const row = rowOf({ repo, branch: "1490-x", worktree: worktreePath(repo, "1490-x") });
      const wt = ensureWorktree(row);
      expect(git(wt, "rev-parse", "HEAD")).toBe(originSha);
      expect(existsSync(join(wt, "l2.txt"))).toBe(true); // the third landing is in the tree
      expect(git(repo, "rev-parse", "main")).toBe(staleSha); // local main is left alone
      // the branch has no upstream pinned to origin/main
      expect(Bun.spawnSync(["git", "-C", wt, "config", "branch.1490-x.merge"]).exitCode).not.toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("base_sha is measured against origin/main, so a stale local main adds no phantom commits ahead (1490)", async () => {
    const { base, repo, originSha } = staleMainRepo(2);
    try {
      const row = rowOf({ repo, branch: "1490-y", worktree: worktreePath(repo, "1490-y") });
      const prep = prepareLaunchWith(repo, "t3", "claude", row);
      expect(prep.base_sha).toBe(originSha);
      expect(commitsAheadFor(prep.worktree, "1490-y", prep.base_sha)).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // --- 1760: cleanup and landCommitFor measure against origin/main too ----------------------------------

  test("landCommitFor finds a land that is only on origin/main while local main is stale (1760)", async () => {
    const { base, repo, staleSha } = staleMainRepo(0);
    try {
      const lander = join(base, "land");
      writeFileSync(join(lander, "x.txt"), "x");
      git(lander, "add", "-A");
      git(lander, "commit", "-m", "feat(ob 1760): the land");
      git(lander, "push", "origin", "main");
      const landSha = git(lander, "rev-parse", "--short", "HEAD");
      git(repo, "fetch", "origin");
      expect(git(repo, "rev-parse", "main")).toBe(staleSha);
      expect(landCommitFor(repo, "1760")).toBe(landSha);
      expect(landCommitFor(repo, "9999")).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("cleanup sweeps a worktree merged into origin/main though local main is stale, and keeps an unmerged one (1760)", async () => {
    const { base, repo } = staleMainRepo(0);
    try {
      // two branches cut from the stale main; only `1760-landed` is pushed into origin/main
      const wtLanded = join(base, "wt-landed");
      const wtOpen = join(base, "wt-open");
      git(repo, "worktree", "add", wtLanded, "-b", "1760-landed");
      git(repo, "worktree", "add", wtOpen, "-b", "1760-open");
      for (const [wt, f] of [[wtLanded, "landed.txt"], [wtOpen, "open.txt"]] as const) {
        writeFileSync(join(wt, f), f);
        git(wt, "add", "-A");
        git(wt, "commit", "-m", `feat(ob 1760): ${f}`);
      }
      git(repo, "push", "origin", "1760-landed:main");
      git(repo, "fetch", "origin");
      expect(git(repo, "rev-parse", "main")).not.toBe(git(repo, "rev-parse", "origin/main")); // local main is stale
      const db = freshDb();
      const res = await cleanupWorktrees(db, { repo });
      expect(res.removed.map((e) => e.branch)).toEqual(["1760-landed"]);
      expect(res.skipped.find((e) => e.branch === "1760-open")?.reason).toMatch(/not merged/);
      expect(existsSync(wtLanded)).toBe(false);
      expect(git(repo, "branch", "--list", "1760-landed")).toBe(""); // branch really deleted (needs -D: HEAD is stale)
      expect(git(repo, "branch", "--list", "1760-open")).toContain("1760-open");
      expect(git(repo, "branch", "--list", "main")).toContain("main"); // local main is never swept
      expect(existsSync(wtOpen)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // --- 1871: reconcile's default checker measures against origin/main too ---------------------------------

  test("gitMergedChecker reads origin/main when it is ahead of local main, per repo (1871)", () => {
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      if (cmd.includes("--verify")) return cmd.includes("/r/none") ? { ok: false, err: "", out: "" } : { ok: true, err: "", out: "originsha\n" };
      if (cmd.includes("--is-ancestor")) return { ok: false, err: "", out: "" }; // origin is NOT behind local main
      if (cmd.includes("--merged")) return { ok: true, err: "", out: cmd.includes("originsha") ? "feat-1\n" : "main\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      const check = gitMergedChecker();
      expect(check("/r/x", "feat-1")).toBe(true); // only origin/main contains it
      expect(check("/r/none", "feat-1")).toBe(false); // no origin: falls back to local main, which does not
      expect(calls.find((c) => c.includes("--merged") && c.includes("originsha"))).toBeDefined();
      expect(calls.find((c) => c.includes("--merged") && c.includes("main") && c.includes("/r/none"))).toBeDefined();
    } finally {
      restore();
    }
  });

  test("gitMergedChecker marks a branch merged into origin/main though local main is stale; no origin keeps local main (1871)", () => {
    const { base, repo } = staleMainRepo(0);
    try {
      git(repo, "worktree", "add", join(base, "wt-a"), "-b", "1871-landed");
      git(repo, "worktree", "add", join(base, "wt-b"), "-b", "1871-open");
      for (const [b, f] of [["wt-a", "a2.txt"], ["wt-b", "b2.txt"]] as const) {
        writeFileSync(join(base, b, f), f);
        git(join(base, b), "add", "-A");
        git(join(base, b), "commit", "-m", `feat(ob 1871): ${f}`);
      }
      git(repo, "push", "origin", "1871-landed:main");
      git(repo, "fetch", "origin");
      expect(git(repo, "rev-parse", "main")).not.toBe(git(repo, "rev-parse", "origin/main"));
      const check = gitMergedChecker();
      expect(check(repo, "1871-landed")).toBe(true);
      expect(check(repo, "1871-open")).toBe(false);
      // origin absent: local main is the measure, as before
      git(repo, "remote", "remove", "origin");
      git(repo, "merge", "--ff-only", "1871-landed");
      const local = gitMergedChecker();
      expect(local(repo, "1871-landed")).toBe(true);
      expect(local(repo, "1871-open")).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a fetch that fails still launches from the last-fetched origin/main and says so (1490)", async () => {
    const { base, repo } = staleMainRepo(1);
    try {
      git(repo, "fetch", "origin"); // origin/main is now the landed commit
      const landed = git(repo, "rev-parse", "origin/main");
      git(repo, "remote", "set-url", "origin", join(base, "gone.git")); // fetch will fail
      const row = rowOf({ repo, branch: "1490-z", worktree: worktreePath(repo, "1490-z") });
      const wt = ensureWorktree(row);
      expect(git(wt, "rev-parse", "HEAD")).toBe(landed);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("State: line and changed paths are the branch's own, not the landings a stale local main lacks (1490)", async () => {
    const { base, repo } = staleMainRepo(2);
    try {
      git(repo, "fetch", "origin");
      // a landing carries its own State: line; the builder has not committed yet
      const wt = ensureWorktree(rowOf({ repo, branch: "1490-s", worktree: worktreePath(repo, "1490-s") }));
      expect(readChangedPaths(wt, "1490-s", null)).toEqual([]);
      writeFileSync(join(wt, "mine.txt"), "m");
      git(wt, "add", "-A");
      git(wt, "commit", "-m", "fix(ob 1490): mine"); // no State: line of its own
      expect(readCommitState(wt, "1490-s")).toBeNull(); // a range off the stale local main would return a landing's State: line
      expect(readChangedPaths(wt, "1490-s", null)).toEqual(["mine.txt"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an adopted branch cut from a local main that is AHEAD of origin keeps that base (1490)", async () => {
    const { base, repo } = staleMainRepo(1);
    try {
      writeFileSync(join(repo, "unpushed.txt"), "u");
      git(repo, "add", "-A");
      git(repo, "commit", "-m", "chore: unpushed local commit");
      git(repo, "branch", "1490-a", "main"); // cut from the local main, ahead of (and diverged from) nothing it lacks
      const localMain = git(repo, "rev-parse", "main");
      const wt = join(base, "adopted");
      git(repo, "worktree", "add", wt, "1490-a");
      writeFileSync(join(wt, "mine.txt"), "m");
      git(wt, "add", "-A");
      git(wt, "commit", "-m", "fix(ob 1490): mine");
      const prep = prepareLaunchWith(repo, "t3", "claude", rowOf({ repo, branch: "1490-a", worktree: wt }));
      expect(prep.base_sha).toBe(localMain);
      expect(commitsAheadFor(wt, "1490-a", prep.base_sha)).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // --- adoption (#61): a branch already checked out elsewhere is REUSED, not re-`add`ed -------------

  test("adopts a branch already checked out at a DIFFERENT worktree: reuses that path, never `git worktree add`", async () => {
    const { base, repo, row } = setup();
    const elsewhere = join(base, "elsewhere-checkout");
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      if (cmd.includes("list")) {
        return { ok: true, err: "", out: `worktree ${elsewhere}\nHEAD deadbeef\nbranch refs/heads/${row.branch}\n` };
      }
      return { ok: true, err: "" };
    });
    let resolved: string;
    try {
      resolved = ensureWorktree(row);
    } finally {
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(resolved).toBe(elsewhere); // reused, NOT the derived <repo>.<branch> path
    expect(calls).toHaveLength(1); // only the list query, never attempted `git worktree add` on top
    expect(calls[0]).toEqual(["git", "-C", repo, "worktree", "list", "--porcelain"]);
  });

  test("an unrelated existing worktree (different branch) is not mistaken for adoption", async () => {
    const { base, repo, branch, wt, row } = setup();
    const calls: string[][] = [];
    const restore = __setSh((cmd) => {
      calls.push(cmd);
      if (cmd.includes("list")) {
        return { ok: true, err: "", out: `worktree ${join(base, "other")}\nHEAD deadbeef\nbranch refs/heads/some-other-branch\n` };
      }
      mkdirSync(wt, { recursive: true });
      return { ok: true, err: "" };
    });
    let resolved: string;
    try {
      resolved = ensureWorktree(row);
    } finally {
      restore();
      rmSync(base, { recursive: true, force: true });
    }
    expect(resolved).toBe(wt); // created fresh, the other worktree carries a different branch
    expect(calls[4]).toEqual(["git", "-C", repo, "worktree", "add", wt, "-b", branch, "main"]);
  });
});

describe("CLI: ob spinoff brief (154/G3)", () => {
  test("prints the same bare ask enqueue would store, without launching", async () => {
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["spinoff", "brief", "154", "--branch", "cue-154"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Read 154's brief");
    expect(r.out).not.toContain("Operating procedure");
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
    expect(rows).toHaveLength(0);
  });

  test("--json returns { ticket, branch, brief }", async () => {
    const dbPath = freshDbPath();
    // --repo omnislash: the test's cwd is a subdirectory, which reads as a clean repo (OB-1992).
    const j = JSON.parse((await runCli(dbPath, ["spinoff", "brief", "154", "--repo", fakeRepoDir(), "--json"])).out);
    expect(j).toMatchObject({ ticket: "154", branch: "154" });
    expect(j.brief).toContain("Read 154's brief");
    expect(j.brief).not.toContain("Operating procedure");
  });

  test("a custom --brief head is used", async () => {
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["spinoff", "brief", "154", "--repo", fakeRepoDir(), "--brief", "Do the seam."]);
    expect(r.out.trim()).toBe(withStage("Do the seam.").trim());
    expect(r.out).not.toContain("Operating procedure");
  });

  test("missing ticket is a usage error", async () => {
    const r = await runCli(freshDbPath(), ["spinoff", "brief"]);
    expect(r.code).toBe(2);
  });
});

describe("CLI: ob spinoff", () => {
  test("enqueue writes a pending DB row and reports it", async () => {
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, [
      "spinoff", "queue", "--no-check", "a test fixture", "CUE-9893", "--repo", fakeRepoDir(), "--branch", "cue-9893-x", "--brief", "seed brief", "--json",
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ticket: "CUE-9893", status: "queued", deduped: false });

    const list = await runCli(dbPath, ["spinoff", "list", "--json"]);
    const rows = JSON.parse(list.out) as SpinoffRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticket_ref: "CUE-9893", status: "queued" });
    expect(rows[0]!.brief).toBe(withStage("seed brief"));
  });

  test("enqueue via stdin brief", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-spin-cli-"));
    const dbPath = join(dir, "omnislash.sqlite");
    const enq = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "../../../apps/cli/src/index.ts"), "spinoff", "queue", "--no-check", "a test fixture", "CUE-9894", "--repo", fakeRepoDir(), "--branch", "cue-9894", "--brief", "-", "--json"],
      { cwd: process.cwd(), stdin: Buffer.from("do the transcript"), stdout: "pipe", stderr: "pipe", env: { ...process.env, OMNISLASH_DB: dbPath } },
    );
    expect(enq.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(enq.stdout))).toMatchObject({ ticket: "CUE-9894", deduped: false });
    // One real `bun` CLI (§ helpers.ts, "a test that SPAWNS declares it"): cold-starting the whole CLI is
    // the cost this test owns, and at load 160 it ran out bun's flat 5 s at 5.04 s while the enqueue itself
    // was milliseconds.
  }, spawnBudget(1));

  test("bare ob spinoff (no ticket) is a usage error", async () => {
    const r = await runCli(freshDbPath(), ["spinoff"]);
    expect(r.code).toBe(2);
  });

  test("--worktree overrides the derived path (#61)", async () => {
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, [
      "spinoff", "queue", "--no-check", "a test fixture", "T-61", "--repo", fakeRepoDir(), "--branch", "t-61", "--worktree", "/custom/checkout/t-61", "--brief", "x", "--json",
    ]);
    expect(r.code).toBe(0);
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
    expect(rows[0]!.worktree).toBe("/custom/checkout/t-61");
  });

  test("--repo accepts a slug resolved via repo_checkouts, not only a filesystem path (#61)", async () => {
    const dbPath = freshDbPath();
    const checkout = fakeRepoDir();
    const db = openDb(dbPath);
    await setConfig(db, "repo_checkouts", JSON.stringify({ "acmecorp/cue-frontend": checkout }));
    db.close();
    const r = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "T-62", "--repo", "acmecorp/cue-frontend", "--branch", "t-62", "--brief", "x", "--json"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
    expect(rows[0]!.repo).toBe(checkout);
  });

  test("an unresolvable --repo slug errors clearly instead of failing later at launch", async () => {
    const r = await runCli(freshDbPath(), ["spinoff", "queue", "T-63", "--repo", "totally/bogus-repo-xyz", "--branch", "t-63", "--brief", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("bogus-repo-xyz");
    expect(r.err).toContain("repo_checkouts");
  });
});

describe("resolveRepo (#61): --repo accepts a slug, not only a filesystem path", () => {
  test("an existing git-repo directory is used as-is", async () => {
    const db = freshDb();
    const dir = fakeRepoDir();
    expect(resolveRepo(db, dir)).toBe(dir);
  });

  test("resolves via a configured repo_checkouts entry, keyed by the exact slug", async () => {
    const db = freshDb();
    const dir = fakeRepoDir();
    await setConfig(db, "repo_checkouts", JSON.stringify({ "acmecorp/cue-frontend": dir }));
    expect(resolveRepo(db, "acmecorp/cue-frontend")).toBe(dir);
  });

  test("resolves via a configured repo_checkouts entry, keyed by the last path segment", async () => {
    const db = freshDb();
    const dir = fakeRepoDir();
    await setConfig(db, "repo_checkouts", JSON.stringify({ "cue-frontend": dir }));
    expect(resolveRepo(db, "acmecorp/cue-frontend")).toBe(dir);
  });

  test("falls back to ~/dev/<name> when it exists and is a git repo (home is injectable)", async () => {
    const db = freshDb();
    const home = mkdtempSync(join(tmpdir(), "ob-fakehome-"));
    const devRepo = join(home, "dev", "cue-frontend");
    mkdirSync(join(devRepo, ".git"), { recursive: true });
    try {
      expect(resolveRepo(db, "acmecorp/cue-frontend", home)).toBe(devRepo);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a repo_checkouts entry pointing at a non-git / missing path is ignored, falling through", async () => {
    const db = freshDb();
    await setConfig(db, "repo_checkouts", JSON.stringify({ "cue-frontend": "/does/not/exist" }));
    const home = mkdtempSync(join(tmpdir(), "ob-fakehome-"));
    const devRepo = join(home, "dev", "cue-frontend");
    mkdirSync(join(devRepo, ".git"), { recursive: true });
    try {
      expect(resolveRepo(db, "acmecorp/cue-frontend", home)).toBe(devRepo); // falls through to ~/dev
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("errors clearly, naming what was tried, when nothing resolves", async () => {
    const db = freshDb();
    const home = mkdtempSync(join(tmpdir(), "ob-fakehome-"));
    try {
      expect(() => resolveRepo(db, "totally/bogus-repo-xyz", home)).toThrow(
        /repo 'totally\/bogus-repo-xyz' not found: not a local path, no repo_checkouts entry, and .*bogus-repo-xyz is not a git repo/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- --repo resolves to a slug on the CLIENT, before dispatch (ob 217) ------

describe("repoDispatchSlug (217): a --repo PATH becomes a machine-independent slug here", () => {
  /** A temp $HOME with `dev/<name>/.git` per name, so `resolveRepo`'s ~/dev fallback resolves for real. */
  function fakeHome(...names: string[]): { home: string; path: (n: string) => string; cleanup: () => void } {
    const home = mkdtempSync(join(tmpdir(), "ob-slug-home-"));
    for (const n of names) mkdirSync(join(home, "dev", n, ".git"), { recursive: true });
    return {
      home,
      path: (n: string) => join(home, "dev", n),
      cleanup: () => rmSync(home, { recursive: true, force: true }),
    };
  }

  test("a path inside a checkout resolves to that repo's slug", async () => {
    const db = freshDb();
    const h = fakeHome("cue-frontend");
    try {
      expect(repoDispatchSlug(db, h.path("cue-frontend"), "/", h.home)).toEqual({ slug: "cue-frontend", error: null });
    } finally {
      h.cleanup();
    }
  });

  test("a bare slug passes through unchanged: it is already machine-independent", async () => {
    const db = freshDb();
    expect(repoDispatchSlug(db, "acmecorp/cue-frontend", "/")).toEqual({ slug: "acmecorp/cue-frontend", error: null });
    expect(repoDispatchSlug(db, "omnislash", "/")).toEqual({ slug: "omnislash", error: null });
  });

  test("a relative path and a symlinked one canonicalise to the same slug (lease-key precedent)", async () => {
    const db = freshDb();
    const h = fakeHome("omnislash");
    const link = join(h.home, "link-to-omnislash");
    symlinkSync(h.path("omnislash"), link);
    try {
      expect(repoDispatchSlug(db, "omnislash", join(h.home, "dev"), h.home).slug).toBe("omnislash");
      expect(repoDispatchSlug(db, "./omnislash", join(h.home, "dev"), h.home).slug).toBe("omnislash");
      expect(repoDispatchSlug(db, "../dev/omnislash", join(h.home, "dev"), h.home).slug).toBe("omnislash");
      expect(repoDispatchSlug(db, link, "/", h.home).slug).toBe("omnislash");
    } finally {
      h.cleanup();
    }
  });

  test("a `wt` worktree resolves to its REPO's slug, the way 235 already reads a worktree directory", async () => {
    const db = freshDb();
    const h = fakeHome("omnislash", "omnislash.217-spinoff-repo-slug");
    try {
      expect(repoDispatchSlug(db, h.path("omnislash.217-spinoff-repo-slug"), "/", h.home).slug).toBe("omnislash");
    } finally {
      h.cleanup();
    }
  });

  /** A linked git worktree at `wt` whose `.git` file names `main`'s common dir, the way git writes one. */
  function linkedWorktree(main: string, wt: string): void {
    const gitdir = join(main, ".git", "worktrees", basename(wt));
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
  }

  test("a T3 composer worktree (~/.t3/worktrees/<repo>/t3-<id>) resolves to its repo's slug via its git common dir (1414)", async () => {
    const db = freshDb();
    const h = fakeHome("omnislash");
    const wt = join(h.home, ".t3", "worktrees", "omnislash", "t3-d2ce33da");
    try {
      linkedWorktree(h.path("omnislash"), wt);
      expect(repoDispatchSlug(db, wt, "/", h.home)).toEqual({ slug: "omnislash", error: null });
    } finally {
      h.cleanup();
    }
  });

  test("a T3 worktree whose repo no slug maps back to still REFUSES, naming what to add", async () => {
    const db = freshDb();
    const h = fakeHome();
    const elsewhere = fakeRepoDir(); // a real checkout, not under ~/dev and not in repo_checkouts
    const wt = join(h.home, ".t3", "worktrees", "elsewhere", "t3-abc123");
    try {
      linkedWorktree(elsewhere, wt);
      const res = repoDispatchSlug(db, wt, "/", h.home);
      expect(res.slug).toBeNull();
      expect(res.error).toContain("repo_checkouts");
      expect(res.error).toContain(realpathSync(elsewhere));
    } finally {
      h.cleanup();
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a path outside any checkout REFUSES rather than guessing a slug from the basename", async () => {
    const db = freshDb();
    const outside = mkdtempSync(join(tmpdir(), "ob-not-a-repo-"));
    try {
      const res = repoDispatchSlug(db, outside, "/");
      expect(res.slug).toBeNull();
      expect(res.error).toContain("is not a git checkout");
      expect(res.error).toContain(realpathSync(outside));

      const gone = repoDispatchSlug(db, join(outside, "nope"), "/");
      expect(gone.slug).toBeNull();
      expect(gone.error).toContain("names no directory on this machine");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a checkout no slug maps back to REFUSES, naming what to add", async () => {
    const db = freshDb();
    const h = fakeHome();
    const elsewhere = fakeRepoDir(); // a real checkout, but not under ~/dev and not in repo_checkouts
    try {
      const res = repoDispatchSlug(db, elsewhere, "/", h.home);
      expect(res.slug).toBeNull();
      expect(res.error).toContain("repo_checkouts");
      expect(res.error).toContain(realpathSync(elsewhere));
    } finally {
      h.cleanup();
    }
  });

  test("a second checkout with the same basename REFUSES: the basename slug names the other one here", async () => {
    const db = freshDb();
    const h = fakeHome("cue-frontend"); // ~/dev/cue-frontend
    const other = join(h.home, "experiments", "cue-frontend"); // a second checkout with the same basename
    mkdirSync(join(other, ".git"), { recursive: true });
    try {
      const res = repoDispatchSlug(db, other, "/", h.home);
      expect(res.slug).toBeNull();
      expect(res.error).toContain("ambiguous");
      expect(res.error).toContain(realpathSync(other));
      expect(res.error).toContain(realpathSync(h.path("cue-frontend")));
      expect(res.error).toContain("repo_checkouts");
      // ... and a repo_checkouts key pointing at it settles it: that key is a slug that resolves back here
      await setConfig(db, "repo_checkouts", JSON.stringify({ "mine/cue-frontend": other }));
      expect(repoDispatchSlug(db, other, "/", h.home)).toEqual({ slug: "mine/cue-frontend", error: null });
    } finally {
      h.cleanup();
    }
  });

  test("rowRepoPath: a slug row resolves to this machine's checkout, an absolute path is left alone", async () => {
    const db = freshDb();
    const checkout = fakeRepoDir();
    await setConfig(db, "repo_checkouts", JSON.stringify({ "cue-frontend": checkout }));
    expect(rowRepoPath(db, "cue-frontend")).toBe(checkout);
    expect(rowRepoPath(db, "/r/cue-frontend")).toBe("/r/cue-frontend"); // never re-resolved
    expect(rowRepoPath(db, "no-such-repo-xyz")).toBe("no-such-repo-xyz"); // handed back, not thrown
  });
});

describe("rewriteSpinoffRepoArgv (217): the rewrite happens BEFORE dispatch", () => {
  const enqueue = (repo: string) => ["spinoff", "T-1", "--repo", repo, "--branch", "t-1", "--brief", "x"];

  test("the dispatched argv carries the slug, in either flag form", async () => {
    const db = freshDb();
    const checkout = fakeRepoDir();
    await setConfig(db, "repo_checkouts", JSON.stringify({ "cue-frontend": checkout }));
    const spaced = rewriteSpinoffRepoArgv({
      argv: enqueue(checkout),
      command: "spinoff",
      args: ["T-1"],
      flags: { repo: checkout },
      db,
      cwd: "/",
    });
    expect(spaced.error).toBeNull();
    expect(spaced.argv).toEqual(["spinoff", "T-1", "--repo", "cue-frontend", "--branch", "t-1", "--brief", "x"]);

    const joined = rewriteSpinoffRepoArgv({
      argv: ["spinoff", "T-1", `--repo=${checkout}`],
      command: "spinoff",
      args: ["T-1"],
      flags: { repo: checkout },
      db,
      cwd: "/",
    });
    expect(joined.argv).toEqual(["spinoff", "T-1", "--repo=cue-frontend"]);
  });

  test("with no --repo the CWD is resolved here too, since the server's cwd is never the repo meant", async () => {
    const db = freshDb();
    const checkout = fakeRepoDir();
    await setConfig(db, "repo_checkouts", JSON.stringify({ "cue-frontend": checkout }));
    const res = rewriteSpinoffRepoArgv({
      argv: ["spinoff", "T-1"],
      command: "spinoff",
      args: ["T-1"],
      flags: {},
      db,
      cwd: checkout,
    });
    expect(res.argv).toEqual(["spinoff", "T-1", "--repo", "cue-frontend"]);
  });

  test("only the ENQUEUE is rewritten: the subcommands and other commands pass through untouched", async () => {
    const db = freshDb();
    const checkout = fakeRepoDir();
    for (const [command, args] of [
      ["spinoff", ["drain"]],
      ["spinoff", ["brief", "T-1"]],
      ["spinoff", ["show", "T-1"]],
      ["spinoff", ["cleanup"]],
    ] as Array<[string, string[]]>) {
      const argv = [command, ...args, "--repo", checkout];
      expect(rewriteSpinoffRepoArgv({ argv, command, args, flags: { repo: checkout }, db, cwd: "/" })).toEqual({
        argv,
        error: null,
      });
    }
  });
});

describe("ob spinoff --repo over the wire (217): nothing machine-local is dispatched", () => {
  /** An ssh stub: it records the argv it was handed and never runs anything. */
  function recordingExec() {
    const calls: string[][] = [];
    return {
      calls,
      stream(_host: string, argv: string[]) {
        calls.push(argv);
        return { code: 0, connectionFailed: false };
      },
      capture(_host: string, argv: string[]) {
        calls.push(argv);
        return { code: 0, connectionFailed: false, stdout: "", stderr: "" };
      },
      fetch(_host: string, argv: string[]) {
        calls.push(argv);
        return { code: 0, connectionFailed: false, stderr: "", bytes: new Uint8Array() };
      },
    };
  }

  async function runDispatched(dbPath: string, argv: string[]) {
    const exec = recordingExec();
    const prevDb = process.env.OMNISLASH_DB;
    const origErr = process.stderr.write.bind(process.stderr);
    let err = "";
    (process.stderr.write as unknown) = (chunk: string) => {
      err += chunk;
      return true;
    };
    process.env.OMNISLASH_DB = dbPath;
    try {
      return { code: await run(argv, { exec }), err, calls: exec.calls };
    } finally {
      (process.stderr.write as unknown) = origErr;
      if (prevDb === undefined) delete process.env.OMNISLASH_DB;
      else process.env.OMNISLASH_DB = prevDb;
    }
  }

  async function clientDb(checkouts: Record<string, string>): Promise<string> {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    await setConfig(db, "remote_host", "ob@10.0.0.20");
    await setConfig(db, "repo_checkouts", JSON.stringify(checkouts));
    db.close();
    return dbPath;
  }

  test("a --repo PATH crosses the wire as a slug, and the path itself never does", async () => {
    const checkout = fakeRepoDir();
    const dbPath = await clientDb({ "cue-frontend": checkout });
    const r = await runDispatched(dbPath, ["spinoff", "queue", "CUE-1", "--repo", checkout, "--branch", "cue-1", "--brief", "x"]);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toEqual(["spinoff", "queue", "CUE-1", "--repo", "cue-frontend", "--branch", "cue-1", "--brief", "x"]);
    expect(r.calls.flat().join(" ")).not.toContain(checkout);
  });

  test("a --repo outside every checkout is refused HERE: nothing is dispatched", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ob-not-a-repo-"));
    const dbPath = await clientDb({});
    try {
      const r = await runDispatched(dbPath, ["spinoff", "queue", "CUE-2", "--repo", outside, "--branch", "cue-2", "--brief", "x"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("is not a git checkout");
      expect(r.calls).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a dispatched enqueue records the slug verbatim: the server never re-resolves it", async () => {
    // The server side of the same invocation. It has none of the client's checkouts, so resolving the
    // value there is exactly the defect; with the hop marker set it records what the client resolved.
    const dbPath = freshDbPath();
    openDb(dbPath).close();
    const prevHop = process.env.OB_REMOTE_HOP;
    process.env.OB_REMOTE_HOP = "1";
    try {
      const r = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "CUE-3", "--repo", "cue-frontend", "--branch", "cue-3", "--brief", "x", "--json"]);
      expect(r.code).toBe(0);
      const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as SpinoffRow[];
      expect(rows[0]!.repo).toBe("cue-frontend");
    } finally {
      if (prevHop === undefined) delete process.env.OB_REMOTE_HOP;
      else process.env.OB_REMOTE_HOP = prevHop;
    }
  });
});

// --- worktree cleanup (217) ------------------------------------------------

describe("decideCleanup (217) — pure decision logic", () => {
  const cand = (over: Partial<Parameters<typeof decideCleanup>[0]> = {}) => ({
    branch: "fix-1",
    path: "/r/repo.fix-1",
    merged: true,
    dirty: false,
    isMain: false,
    ...over,
  });

  test("merged + clean → remove", async () => {
    expect(decideCleanup(cand())).toEqual({ action: "remove" });
  });

  test("dirty → skip with reason (never delete uncommitted work)", async () => {
    const d = decideCleanup(cand({ dirty: true }));
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/uncommitted/);
  });

  test("unmerged → skip with reason (never delete unmerged work)", async () => {
    const d = decideCleanup(cand({ merged: false }));
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/not merged/);
  });

  test("isMain → skip, even with --force (main checkout never removed)", async () => {
    expect(decideCleanup(cand({ isMain: true })).action).toBe("skip");
    expect(decideCleanup(cand({ isMain: true, dirty: true, merged: false }), { force: true }).action).toBe("skip");
  });

  test("--force → remove dirty and/or unmerged (explicit opt-in)", async () => {
    expect(decideCleanup(cand({ dirty: true }), { force: true })).toEqual({ action: "remove" });
    expect(decideCleanup(cand({ merged: false }), { force: true })).toEqual({ action: "remove" });
    expect(decideCleanup(cand({ dirty: true, merged: false }), { force: true })).toEqual({ action: "remove" });
  });
});

describe("parseWorktreeList (217) — pure porcelain parse", () => {
  test("first block is main; branch stripped of refs/heads; detached → null branch", async () => {
    const porcelain = [
      "worktree /r/repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /r/repo.fix-1",
      "HEAD bbb",
      "branch refs/heads/fix-1",
      "",
      "worktree /r/repo.detached",
      "HEAD ccc",
      "detached",
      "",
    ].join("\n");
    const wts = parseWorktreeList(porcelain);
    expect(wts).toEqual([
      { path: "/r/repo", branch: "main", isMain: true },
      { path: "/r/repo.fix-1", branch: "fix-1", isMain: false },
      { path: "/r/repo.detached", branch: null, isMain: false },
    ]);
  });

  test("empty input → no worktrees", async () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

// A fixture git seam: answers the read-only queries from an in-memory model and records mutations.
// NO real git is ever run.
interface GitModel {
  repo: string;
  worktrees: Array<{ path: string; branch: string | null; isMain?: boolean }>;
  merged: string[]; // branches merged into main
  branches: string[]; // all local branches
  dirty?: string[]; // worktree paths with uncommitted changes
  failRemove?: string[]; // worktree paths whose `worktree remove` fails
  processes?: string[]; // argv[0] of extra processes (ob 138); default = none, table still saw self
  ps?: "ok" | "fail" | "no-self";
  githubRemote?: boolean; // OB-2141: the checkout has a GitHub remote gh can resolve {owner}/{repo} from
  prOut?: string; // OB-2141: what the paginated `gh api` merged-PR read prints
  ghFail?: string; // OB-2141: the gh read fails with this stderr
  tips?: Record<string, string>; // OB-2141: local branch tip shas
}
function fakeGit(model: GitModel) {
  const mutations: string[][] = [];
  const reads: string[][] = [];
  const fake = (cmd: string[]): ShResult => {
    if (cmd[0] === "ps") {
      if (model.ps === "fail") return { ok: false, err: "ps: no", out: "" };
      return { ok: true, err: "", out: psTable(model.processes ?? [], { sawSelf: model.ps !== "no-self" }) };
    }
    // status --porcelain <path>  (git -C <path> status --porcelain)
    if (cmd.includes("status") && cmd.includes("--porcelain")) {
      const ci = cmd.indexOf("-C");
      const path = cmd[ci + 1]!;
      return { ok: true, err: "", out: (model.dirty ?? []).includes(path) ? " M file.ts\n" : "" };
    }
    if (cmd.includes("worktree") && cmd.includes("list")) {
      const out = model.worktrees
        .map((w) => `worktree ${w.path}\nHEAD deadbeef${w.branch ? `\nbranch refs/heads/${w.branch}` : "\ndetached"}`)
        .join("\n\n");
      return { ok: true, err: "", out };
    }
    if (cmd.includes("branch") && cmd.includes("--merged")) {
      return { ok: true, err: "", out: model.merged.join("\n") };
    }
    if (cmd.includes("for-each-ref")) {
      if (cmd.some((c) => c.includes("objectname"))) {
        return { ok: true, err: "", out: model.branches.map((b) => `${b} ${model.tips?.[b] ?? "0000000"}`).join("\n") };
      }
      return { ok: true, err: "", out: model.branches.join("\n") };
    }
    if (cmd[0] === "gh" && cmd[1] === "api") {
      reads.push(cmd); // recorded so a test can see the read ran once, with no cap
      if (model.ghFail) return { ok: false, err: model.ghFail, out: "" };
      if (!model.githubRemote) return { ok: false, err: "none of the git remotes configured for this repository point to a known GitHub host", out: "" };
      return { ok: true, err: "", out: model.prOut ?? "" };
    }
    // mutations
    if (cmd.includes("worktree") && cmd.includes("remove")) {
      mutations.push(cmd);
      const path = cmd[cmd.length - 1]!;
      if ((model.failRemove ?? []).includes(path)) return { ok: false, err: "contains modified or untracked files" };
      return { ok: true, err: "", out: "" };
    }
    if (cmd.includes("branch") && (cmd.includes("-d") || cmd.includes("-D"))) {
      mutations.push(cmd);
      return { ok: true, err: "", out: "" };
    }
    return { ok: true, err: "", out: "" };
  };
  const restoreSh = __setSh(fake);
  // OB-2141: the merged-PR read has its own seam; the model answers it through the same fake shell
  const restorePr = __setMergedPrRead((repo) => githubMergedPrHeads(repo, fake));
  const restore = () => {
    restorePr();
    restoreSh();
  };
  return { mutations, reads, restore };
}

describe("cleanupWorktrees (217) — classify + sweep with a mocked git seam", () => {
  const REPO = "/r/repo";
  const baseModel = (): GitModel => ({
    repo: REPO,
    worktrees: [
      { path: REPO, branch: "main", isMain: true },
      { path: `${REPO}.fix-1`, branch: "fix-1" }, // merged + clean → remove
      { path: `${REPO}.fix-2`, branch: "fix-2" }, // merged + DIRTY → skip
      { path: `${REPO}.feat-3`, branch: "feat-3" }, // UNMERGED + clean → skip
    ],
    merged: ["main", "fix-1", "fix-2", "dangling-merged"],
    branches: ["main", "fix-1", "fix-2", "feat-3", "dangling-merged", "dangling-unmerged"],
    dirty: [`${REPO}.fix-2`],
  });

  test("classifies fixture set: removes merged+clean, skips dirty/unmerged, prunes dangling merged branch, never touches main", async () => {
    const db = freshDb();
    const { mutations, restore } = fakeGit(baseModel());
    let res;
    try {
      res = (await cleanupWorktrees(db, { repo: REPO }));
    } finally {
      restore();
    }

    // removed: fix-1 worktree + dangling-merged branch
    const removedBranches = res.removed.map((e) => e.branch).sort(byCodeUnit);
    expect(removedBranches).toEqual(["dangling-merged", "fix-1"]);
    expect(res.removed.find((e) => e.branch === "fix-1")!.kind).toBe("worktree");
    expect(res.removed.find((e) => e.branch === "dangling-merged")!.kind).toBe("branch");

    // skipped: fix-2 (dirty), feat-3 (unmerged), dangling-unmerged (unmerged branch). main NOT listed.
    const skippedBranches = res.skipped.map((e) => e.branch).sort(byCodeUnit);
    expect(skippedBranches).toEqual(["dangling-unmerged", "feat-3", "fix-2"]);
    expect(res.skipped.find((e) => e.branch === "fix-2")!.reason).toMatch(/uncommitted/);
    expect(res.skipped.find((e) => e.branch === "feat-3")!.reason).toMatch(/not merged/);
    expect(res.skipped.some((e) => e.branch === "main")).toBe(false);

    // actual mutations: worktree remove fix-1, branch -D fix-1, branch -D dangling-merged. NEVER main.
    expect(mutations).toContainEqual(["git", "-C", REPO, "worktree", "remove", `${REPO}.fix-1`]);
    expect(mutations).toContainEqual(["git", "-C", REPO, "branch", "-D", "fix-1"]);
    expect(mutations).toContainEqual(["git", "-C", REPO, "branch", "-D", "dangling-merged"]);
    expect(mutations.every((m) => !m.includes("main"))).toBe(true);
    // no force → only branches proven merged are deleted (-D: `-d` would judge them against a stale HEAD, 1760)
    expect(mutations.filter((m) => m.includes("-D")).map((m) => m[m.length - 1]).sort()).toEqual(["dangling-merged", "fix-1"]);
  });

  test("--dry-run removes nothing (no mutations) but reports the same plan", async () => {
    const db = freshDb();
    const { mutations, restore } = fakeGit(baseModel());
    let res;
    try {
      res = (await cleanupWorktrees(db, { repo: REPO, dryRun: true }));
    } finally {
      restore();
    }
    expect(res.dry_run).toBe(true);
    expect(mutations).toHaveLength(0); // NOTHING removed
    expect(res.removed.map((e) => e.branch).sort(byCodeUnit)).toEqual(["dangling-merged", "fix-1"]);
    expect(res.skipped.map((e) => e.branch).sort(byCodeUnit)).toEqual(["dangling-unmerged", "feat-3", "fix-2"]);
  });

  test("--force removes dirty + unmerged too (worktree remove --force + branch -D)", async () => {
    const db = freshDb();
    const { mutations, restore } = fakeGit(baseModel());
    let res;
    try {
      res = (await cleanupWorktrees(db, { repo: REPO, force: true }));
    } finally {
      restore();
    }
    // everything except main is now removed
    expect(res.removed.map((e) => e.branch).sort(byCodeUnit)).toEqual(["dangling-merged", "dangling-unmerged", "feat-3", "fix-1", "fix-2"]);
    expect(res.skipped).toHaveLength(0);
    expect(mutations).toContainEqual(["git", "-C", REPO, "worktree", "remove", "--force", `${REPO}.fix-2`]);
    expect(mutations).toContainEqual(["git", "-C", REPO, "branch", "-D", "fix-2"]);
    expect(mutations.every((m) => !m.includes("main"))).toBe(true); // main still protected under --force
  });

  test("marks the agent-registry row done for each removed branch (ob agents stays truthful)", async () => {
    const db = freshDb();
    (await registerAgent(db, { id: "fix-1", ticket: "197", branch: "fix-1", status: "working", ttlS: 900 }));
    (await registerAgent(db, { id: "feat-3", ticket: "300", branch: "feat-3", status: "working", ttlS: 900 }));
    expect((await listAgents(db)).map((a) => a.id).sort()).toEqual(["feat-3", "fix-1"]);
    const { restore } = fakeGit(baseModel());
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO }));
      expect(res.removed.find((e) => e.branch === "fix-1")!.agent_done).toBe(true);
    } finally {
      restore();
    }
    // fix-1 was removed → its agent row is gone; feat-3 skipped (unmerged) → its agent stays
    expect((await listAgents(db)).map((a) => a.id)).toEqual(["feat-3"]);
  });

  test("dry-run previews agent_done without deleting the registry row", async () => {
    const db = freshDb();
    (await registerAgent(db, { id: "fix-1", ticket: "197", branch: "fix-1", status: "working", ttlS: 900 }));
    const { restore } = fakeGit(baseModel());
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO, dryRun: true }));
      expect(res.removed.find((e) => e.branch === "fix-1")!.agent_done).toBe(true);
    } finally {
      restore();
    }
    expect((await listAgents(db)).map((a) => a.id)).toEqual(["fix-1"]); // still there — dry-run didn't clear it
  });

  test("a detached worktree is skipped (no branch to delete)", async () => {
    const db = freshDb();
    const model = baseModel();
    model.worktrees.push({ path: `${REPO}.detached`, branch: null });
    const { mutations, restore } = fakeGit(model);
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO }));
      const det = res.skipped.find((e) => e.path === `${REPO}.detached`);
      expect(det?.reason).toMatch(/detached/);
    } finally {
      restore();
    }
    expect(mutations.every((m) => !m.includes(`${REPO}.detached`))).toBe(true);
  });

  test("a failed `git worktree remove` is reported as skipped, not silently dropped", async () => {
    const db = freshDb();
    const model = baseModel();
    model.failRemove = [`${REPO}.fix-1`];
    const { restore } = fakeGit(model);
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO }));
      expect(res.removed.some((e) => e.branch === "fix-1")).toBe(false);
      const sk = res.skipped.find((e) => e.branch === "fix-1");
      expect(sk?.reason).toMatch(/worktree remove failed/);
    } finally {
      restore();
    }
  });
});

describe("cleanupWorktrees (138) — skip a worktree a live process was launched from", () => {
  const REPO = "/r/repo";
  const FIX1 = `${REPO}.fix-1`;
  const EXEC = `${FIX1}/apps/widget/Widget`;
  const model = (over: Partial<GitModel> = {}): GitModel => ({
    repo: REPO,
    worktrees: [
      { path: REPO, branch: "main", isMain: true },
      { path: FIX1, branch: "fix-1" },
    ],
    merged: ["main", "fix-1", "dangling-merged"],
    branches: ["main", "fix-1", "dangling-merged"],
    dirty: [],
    ...over,
  });

  test("a process launched from inside the worktree SKIPS it even when merged+clean; dangling branch still prunes", async () => {
    const db = freshDb();
    const { mutations, restore } = fakeGit(model({ processes: [EXEC] }));
    let res;
    try {
      res = await cleanupWorktrees(db, { repo: REPO });
    } finally {
      restore();
    }
    const skip = res.skipped.find((e) => e.branch === "fix-1");
    expect(skip?.reason).toMatch(/in use: pid \d+ launched as /);
    expect(skip?.reason).toContain(EXEC);
    expect(res.removed.map((e) => e.branch)).toEqual(["dangling-merged"]);
    expect(mutations.every((m) => !m.includes(FIX1))).toBe(true);
    expect(mutations).toContainEqual(["git", "-C", REPO, "branch", "-D", "dangling-merged"]);
  });

  test("a sibling worktree path is not a prefix match", async () => {
    const db = freshDb();
    const sibling = `${REPO}.fix-10/apps/widget/Widget`;
    const { mutations, restore } = fakeGit(model({ processes: [sibling] }));
    try {
      const res = await cleanupWorktrees(db, { repo: REPO });
      expect(res.removed.some((e) => e.branch === "fix-1")).toBe(true);
    } finally {
      restore();
    }
    expect(mutations).toContainEqual(["git", "-C", REPO, "worktree", "remove", FIX1]);
  });

  test("unreadable process table SKIPS rather than removes (unknown ≠ not running)", async () => {
    const db = freshDb();
    const { mutations, restore } = fakeGit(model({ ps: "fail" }));
    try {
      const res = await cleanupWorktrees(db, { repo: REPO });
      expect(res.skipped.find((e) => e.branch === "fix-1")?.reason).toMatch(/could not tell if in use/);
      expect(res.removed.some((e) => e.branch === "fix-1")).toBe(false);
    } finally {
      restore();
    }
    expect(mutations.every((m) => !m.includes(FIX1))).toBe(true);
  });

  test("a table without the asker is the same unknown skip", async () => {
    const db = freshDb();
    const { mutations, restore } = fakeGit(model({ ps: "no-self" }));
    try {
      const res = await cleanupWorktrees(db, { repo: REPO });
      expect(res.skipped.find((e) => e.branch === "fix-1")?.reason).toMatch(/could not tell if in use/);
    } finally {
      restore();
    }
    expect(mutations.every((m) => !m.includes(FIX1))).toBe(true);
  });

  test("--force does not override a live process", async () => {
    const db = freshDb();
    const { mutations, restore } = fakeGit(model({ processes: [EXEC] }));
    try {
      const res = await cleanupWorktrees(db, { repo: REPO, force: true });
      expect(res.skipped.find((e) => e.branch === "fix-1")?.reason).toMatch(/in use:/);
    } finally {
      restore();
    }
    expect(mutations.every((m) => !m.includes(FIX1))).toBe(true);
  });

  test("dry-run reports the in-use skip and mutates nothing", async () => {
    const db = freshDb();
    const { mutations, restore } = fakeGit(model({ processes: [EXEC] }));
    try {
      const res = await cleanupWorktrees(db, { repo: REPO, dryRun: true });
      expect(res.dry_run).toBe(true);
      expect(res.skipped.find((e) => e.branch === "fix-1")?.reason).toMatch(/in use:/);
      expect(res.removed.some((e) => e.branch === "fix-1")).toBe(false);
    } finally {
      restore();
    }
    expect(mutations).toHaveLength(0);
  });
});

describe("CLI: ob spinoff cleanup (217) — command wiring, mocked git", () => {
  const REPO = "/r/repo";
  const model = (): GitModel => ({
    repo: REPO,
    worktrees: [
      { path: REPO, branch: "main", isMain: true },
      { path: `${REPO}.fix-1`, branch: "fix-1" },
    ],
    merged: ["main", "fix-1"],
    branches: ["main", "fix-1"],
    dirty: [],
  });

  test("--dry-run --json reports the plan and removes nothing", async () => {
    const { mutations, restore } = fakeGit(model());
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "cleanup", "--repo", REPO, "--dry-run", "--json"]);
      expect(r.code).toBe(0);
      const res = JSON.parse(r.out);
      expect(res.dry_run).toBe(true);
      expect(res.removed.map((e: { branch: string }) => e.branch)).toEqual(["fix-1"]);
    } finally {
      restore();
    }
    expect(mutations).toHaveLength(0);
  });

  test("text summary shows REMOVED with a dry-run prefix and no mutations", async () => {
    const { mutations, restore } = fakeGit(model());
    try {
      const r = await runCli(freshDbPath(), ["spinoff", "cleanup", "--repo", REPO, "--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("DRY RUN");
      expect(r.out).toContain("would remove");
      expect(r.out).toContain(`${REPO}.fix-1`);
    } finally {
      restore();
    }
    expect(mutations).toHaveLength(0);
  });
});

// #135: routing ONE spinoff elsewhere used to mean mutating global config around the dispatch, and
// because the launcher was resolved at DRAIN rather than at queue time, the obvious
// set-setting → queue → restore-setting sequence silently handed the row back to the launcher it was
// trying to avoid: no error, and no sign until the agent ran in the wrong place. These tests pin the
// resolution ORDER, the row-level recording, and the usage error on an unknown value.
describe("spinoff --launcher (#135): a per-row launcher, recorded at queue time", () => {
  test("rowLauncherName: the row wins, then by-repo, then the global; a legacy/unknown row value falls back", async () => {
    const db = freshDb();
    const row = (launcher: string | null) => rowOf({ repo: "/Users/j/dev/omnislash", launcher });

    expect(rowLauncherName(db, row(null))).toBe("t3"); // nothing configured at all
    await setConfig(db, "spinoff_launcher_by_repo", JSON.stringify({ omnislash: "t3" }));
    expect(rowLauncherName(db, row(null))).toBe("t3"); // by-repo
    expect(rowLauncherName(db, row("t3"))).toBe("t3"); // the ROW
    // a row value that is not a routable launcher is a hand-edited row, or a legacy one (#79/ob 1109/1589),
    // not a launch to fail: config decides where a re-launch of it would go, and the stored value is untouched
    for (const legacy of ["teleport", "warp", "headless"]) expect(rowLauncherName(db, row(legacy))).toBe("t3");
  });

  test("enqueue records the launcher on the PENDING row (no flag → null, resolved at drain)", async () => {
    const db = freshDb();
    expect((await enqueueSpinoff(db, input({ ticketRef: "135a", branch: "135-a" }))).row.launcher).toBeNull();
    const pinned = (await enqueueSpinoff(db, input({ ticketRef: "135b", branch: "135-b", launcher: "t3" }))).row;
    expect(pinned.launcher).toBe("t3");
    expect((await listSpinoffs(db, "pending")).find((r) => r.ticket_ref === "135b")?.launcher).toBe("t3");
  });

  test("CLI: --launcher is recorded and echoed; an unknown value is a usage error that queues nothing", async () => {
    const dbPath = freshDbPath();
    const ok = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "135c", "--launcher", "t3", "--branch", "135-c"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("via t3");
    expect((await listSpinoffs(openDb(dbPath), "pending")).map((r) => r.launcher)).toEqual(["t3"]);

    const bad = await runCli(dbPath, ["spinoff", "135d", "--launcher", "tmux", "--branch", "135-d"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("must be one of t3");
    expect((await listSpinoffs(openDb(dbPath), "pending"))).toHaveLength(1); // still just 135c
  });

  // #79/ob 1109/1589: a rejection that only listed the survivor would read as a typo in a value that used
  // to be correct, so it names the value and says what happened to it, while rows already carrying it are
  // left alone.
  test("CLI: --launcher warp|headless is a usage error naming t3, and queues nothing (#79, 1589)", async () => {
    const dbPath = freshDbPath();
    for (const legacy of ["warp", "headless"]) {
      const bad = await runCli(dbPath, ["spinoff", "79a", "--launcher", legacy, "--branch", "79-a"]);
      expect(bad.code).toBe(2);
      expect(bad.err).toContain("must be one of t3");
      expect(bad.err).toContain(`(got '${legacy}')`);
      expect(bad.err).toContain("retired");
      const queued = await runCli(dbPath, ["spinoff", "queue", "79a", "--launcher", legacy, "--branch", "79-a"]);
      expect(queued.code).toBe(2);

      // `ob agent register --launcher <legacy>` is refused the same way, from the same one rejection
      const reg = await runCli(dbPath, ["agent", "register", "--id", "a79", "--launcher", legacy, "--no-lease"]);
      expect(reg.code).toBe(2);
      expect(reg.err).toContain("must be one of t3");
    }
    expect((await listSpinoffs(openDb(dbPath), "pending"))).toHaveLength(0); // queued nothing

    // and the message is one function, so both surfaces say the same thing
    expect(launcherRejection("--launcher", "tmux")).not.toContain("retired"); // a typo is not a removal
  });

  test("drain honours the ROW's launcher over live config (the set-queue-restore race #135 found)", async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "ob-spin-135-row-"));
    const repo = join(dir, "omnislash");
    const branch = "135-row";
    // config carries a retired value stored before 1589; the ROW says t3 and must win
    await setConfig(db, "spinoff_launcher", "warp");
    await setConfig(db, "spinoff_launcher_by_repo", JSON.stringify({ omnislash: "headless" }));
    (await enqueueSpinoff(db, input({ ticketRef: "135", repo, branch, launcher: "t3" })));

    const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
    let r: Awaited<ReturnType<typeof drainSpinoffs>>;
    try {
      r = await drainWithFakeT3(db, [{ repo, branch }]);
    } finally {
      restoreSh();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(r.launched).toEqual(["135"]);
    expect((await listSpinoffs(db, "launched"))[0]?.launcher).toBe("t3");
  });
});

// --- OB-2141: a squash-merged PR counts as merged ------------------------------------------------------

describe("squash-merged PRs count as merged (OB-2141)", () => {
  const REPO = "/r/sq";
  const prLine = (ref: string, sha: string) => JSON.stringify([ref, sha]);
  /** Two pages of the paginated read: 100 unrelated PRs, then the page that carries the ones under test. */
  const twoPages = (lines: string[]) =>
    [...Array.from({ length: 100 }, (_, i) => prLine(`old-${i}`, `old${i}`)), ...lines].join("\n");
  const model = (over: Partial<GitModel> = {}): GitModel => ({
    repo: REPO,
    worktrees: [
      { path: REPO, branch: "main", isMain: true },
      { path: `${REPO}.sq-1`, branch: "sq-1" }, // squash-merged, tip == PR head sha → remove
      { path: `${REPO}.sq-2`, branch: "sq-2" }, // PR merged, but commits added after → skip
    ],
    merged: ["main"], // git ancestry sees neither (a squash is never an ancestor)
    branches: ["main", "sq-1", "sq-2", "sq-dangling"],
    tips: { "sq-1": "aaa111", "sq-2": "bbb999", "sq-dangling": "ccc333" },
    githubRemote: true,
    prOut: twoPages([prLine("sq-1", "aaa111"), prLine("sq-2", "bbb222"), prLine("sq-dangling", "ccc333")]),
    ...over,
  });

  test("parseMergedPrHeads reads every page of the paginated read, keeping each sha a reused ref had", () => {
    const heads = parseMergedPrHeads(twoPages([prLine("sq-1", "aaa111"), prLine("sq-1", "aaa000"), "not json", '{"x":1}']));
    expect(heads.size).toBe(101); // 100 from page one, sq-1 from page two
    expect(heads.get("old-0")?.has("old0")).toBe(true);
    expect([...heads.get("sq-1")!].sort()).toEqual(["aaa000", "aaa111"]);
  });

  test("a squash-merged branch with the same head sha is merged and removed when clean; the read runs once, uncapped", async () => {
    const db = freshDb();
    const { mutations, reads, restore } = fakeGit(model());
    let res;
    try {
      res = await cleanupWorktrees(db, { repo: REPO });
    } finally {
      restore();
    }
    expect(res.removed.map((e) => e.branch).sort(byCodeUnit)).toEqual(["sq-1", "sq-dangling"]);
    expect(mutations).toContainEqual(["git", "-C", REPO, "worktree", "remove", `${REPO}.sq-1`]);
    expect(mutations).toContainEqual(["git", "-C", REPO, "branch", "-D", "sq-1"]);
    expect(res.github_error).toBeUndefined();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("--paginate");
    expect(reads[0]).toContain("repos/{owner}/{repo}/pulls?state=closed&per_page=100");
    expect(reads[0]!.join(" ")).not.toMatch(/--limit/);
  });

  test("a branch whose merged PR head sha differs from the local tip stays not merged and is skipped", async () => {
    const db = freshDb();
    const { mutations, restore } = fakeGit(model());
    let res;
    try {
      res = await cleanupWorktrees(db, { repo: REPO });
    } finally {
      restore();
    }
    const sq2 = res.skipped.find((e) => e.branch === "sq-2");
    expect(sq2?.reason).toMatch(/not merged/);
    expect(mutations.some((m) => m.includes("sq-2") || m.includes(`${REPO}.sq-2`))).toBe(false);
  });

  test("when the GitHub read fails every decision is the git-only one, and the summary says so", async () => {
    const run = async (over: Partial<GitModel>) => {
      const db = freshDb();
      const { restore } = fakeGit(model(over));
      try {
        return await cleanupWorktrees(db, { repo: REPO, dryRun: true });
      } finally {
        restore();
      }
    };
    // git-only baseline: a repo whose PR read returns nothing that matches
    const gitOnly = await run({ prOut: "" });
    for (const over of [{ ghFail: "HTTP 502: Bad Gateway\nmore" }, { githubRemote: false }]) {
      const res = await run(over);
      expect(res.removed).toEqual(gitOnly.removed);
      expect(res.skipped).toEqual(gitOnly.skipped);
      expect(res.github_error).toBeTruthy();
      const lines = renderCleanupLines(res);
      expect(lines.some((l) => /^github: could not read merged PRs \(.+\); squash-merged branches were not recognised$/.test(l))).toBe(true);
    }
    const failed = await run({ ghFail: "HTTP 502: Bad Gateway\nmore" });
    expect(failed.github_error).toBe("HTTP 502: Bad Gateway");
    expect(renderCleanupLines(gitOnly).some((l) => l.startsWith("github:"))).toBe(false);
  });

  test("gitMergedChecker (reconcile, ob spinoff list's landed) sees the same squash-merged set", () => {
    const { restore } = fakeGit(model());
    try {
      const check = gitMergedChecker();
      expect(check(REPO, "sq-1")).toBe(true);
      expect(check(REPO, "sq-2")).toBe(false);
      expect(check(REPO, "sq-dangling")).toBe(true);
    } finally {
      restore();
    }
  });
});

// --- OB-2159: a live spinoff row keeps its worktree and branch, whatever git and the other guards say ---

describe("cleanupWorktrees (OB-2159): a live spinoff row is never swept", () => {
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
    return new TextDecoder().decode(p.stdout).trim();
  };
  /** A real repo with origin/main, plus a worktree whose branch sits AT main (no commits of its own). */
  const repoWithIdleWorktree = () => {
    const base = mkdtempSync(join(tmpdir(), "ob-2159-"));
    const origin = join(base, "origin.git");
    git(base, "init", "--bare", "-b", "main", origin);
    const repo = join(base, "repo");
    git(base, "clone", origin, repo);
    git(repo, "checkout", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");
    git(repo, "push", "origin", "main");
    git(repo, "fetch", "origin");
    const wt = join(base, "wt-317");
    git(repo, "worktree", "add", wt, "-b", "hc-317-idle");
    return { base, repo, wt: realpathSync(wt) };
  };
  /** No lease, a clear t3 guard, and the given live-row answer. */
  const dataWith = (liveRow: CleanupData["liveRow"]): CleanupData => ({
    hold: async () => null,
    agentExists: async () => false,
    t3Hold: async () => null,
    liveRow,
  });
  const building = { id: 1909, status: "launched", ref: "HC-317" };

  for (const force of [false, true]) {
    test(`a building row with an idle thread, an expired lease and a branch at main is skipped${force ? " (--force too)" : ""}`, async () => {
      const { base, repo, wt } = repoWithIdleWorktree();
      try {
        const res = await cleanupWorktrees(freshDb(), { repo, force, data: dataWith(async () => building) });
        const skip = res.skipped.find((e) => e.branch === "hc-317-idle");
        expect(skip?.kind).toBe("worktree");
        expect(skip?.reason).toBe(
          "live spinoff row 1909 HC-317 (building): retire it with ob spinoff abandon HC-317 if it is stale",
        );
        expect(res.removed).toEqual([]);
        expect(existsSync(wt)).toBe(true);
        expect(git(repo, "branch", "--list", "hc-317-idle")).toContain("hc-317-idle");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  }

  for (const force of [false, true]) {
    test(`a branch with no worktree and a handed-off row is skipped in the branch-only pass${force ? " (--force too)" : ""}`, async () => {
      const { base, repo, wt } = repoWithIdleWorktree();
      try {
        git(repo, "worktree", "remove", wt); // only the branch is left
        const handedOff = { id: 7, status: "ready-for-gate", ref: "OB-7" };
        const res = await cleanupWorktrees(freshDb(), {
          repo,
          force,
          data: dataWith(async (branch) => (branch === "hc-317-idle" ? handedOff : null)),
        });
        const skip = res.skipped.find((e) => e.branch === "hc-317-idle");
        expect(skip?.kind).toBe("branch");
        expect(skip?.reason).toContain("live spinoff row 7 OB-7 (handed-off)");
        expect(res.removed).toEqual([]);
        expect(git(repo, "branch", "--list", "hc-317-idle")).toContain("hc-317-idle");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  }

  test("with no live row (landed or failed) the merged worktree is removed as before, and the dry run lists the skip", async () => {
    const { base, repo, wt } = repoWithIdleWorktree();
    try {
      const dry = await cleanupWorktrees(freshDb(), { repo, dryRun: true, data: dataWith(async () => building) });
      expect(renderCleanupLines(dry).some((l) => l.includes("live spinoff row 1909 HC-317 (building)"))).toBe(true);
      const res = await cleanupWorktrees(freshDb(), { repo, data: dataWith(async () => null) });
      expect(res.removed.map((e) => e.branch)).toEqual(["hc-317-idle"]);
      expect(existsSync(wt)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a row read that fails skips the candidate with `could not read spinoff rows` and removes nothing", async () => {
    const { base, repo, wt } = repoWithIdleWorktree();
    try {
      const res = await cleanupWorktrees(freshDb(), {
        repo,
        force: true,
        data: dataWith(async () => {
          throw new Error("api unreachable");
        }),
      });
      expect(res.skipped.find((e) => e.branch === "hc-317-idle")?.reason).toBe("could not read spinoff rows: api unreachable");
      expect(res.removed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the store form finds a building row by branch and by worktree path, and returns null for landed and failed rows", async () => {
    const db = freshDb();
    const base = mkdtempSync(join(tmpdir(), "ob-2159-store-"));
    try {
      const wtBuilding = join(base, "building");
      const wtLanded = join(base, "landed");
      const wtFailed = join(base, "failed");
      for (const p of [wtBuilding, wtLanded, wtFailed]) mkdirSync(p);
      const mk = async (ref: string, branch: string, worktree: string, status: string) => {
        const r = await enqueueSpinoff(db, { ticketRef: ref, repo: "/r/repo", branch, mode: "interactive", brief: "x", worktree });
        db.query("UPDATE spinoff SET status = ? WHERE id = ?").run(status, r.row.id);
        return r.row.id;
      };
      const id = await mk("OB-1", "ob-1", wtBuilding, "launched");
      await mk("OB-2", "ob-2", wtLanded, "merged");
      await mk("OB-3", "ob-3", wtFailed, "failed");
      expect(await storeLiveRow(db, "ob-1", "")).toEqual({ id, status: "launched", ref: "OB-1" });
      expect(await storeLiveRow(db, null, wtBuilding)).toEqual({ id, status: "launched", ref: "OB-1" });
      expect(await storeLiveRow(db, "other", `${base}/./building`)).toEqual({ id, status: "launched", ref: "OB-1" });
      expect(await storeLiveRow(db, "ob-2", wtLanded)).toBeNull();
      expect(await storeLiveRow(db, "ob-3", wtFailed)).toBeNull();
      expect(await storeCleanupData(db).liveRow("ob-1", "")).not.toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the API form lists the rows once per sweep, for three candidates", async () => {
    let calls = 0;
    const client = {
      spinoffs: async () => {
        calls++;
        return {
          spinoffs: [{ id: 5, status: "launched", ticket_ref: "OB-5", branch: "b", worktree: "/nowhere/b", t3_thread_id: null }],
        };
      },
    } as unknown as ApiClient;
    const data = apiCleanupData(client, "me");
    expect(await data.liveRow("a", "/nowhere/a")).toBeNull();
    expect(await data.liveRow("b", "")).toEqual({ id: 5, status: "launched", ref: "OB-5" });
    expect(await data.liveRow(null, "/nowhere/b")).toEqual({ id: 5, status: "launched", ref: "OB-5" });
    expect(await data.t3Hold?.("/nowhere/b")).toBeNull();
    expect(calls).toBe(1);
  });
});

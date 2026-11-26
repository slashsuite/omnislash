// OB-2256: "planner" is "architect" everywhere ob speaks, with no alias. These assert the surface: the check flag,
// the handoff, gateable, sendback and spike text, the T3 labels, the clean-repo guard, the help and the skills.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { COMMAND_HELP, HELP, renderCommandHelp, renderEnvHelp, renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import type { T3Project } from "../../../apps/cli/src/t3/client.ts";
import { readyingNote, renderReadyNoteOutcome, spikeAnsweredNote, spikeClosedNote } from "../../../apps/cli/src/t3/dispatch.ts";
import { buildT3Tree, indexT3Rows, renderT3Tree, threadObLabel, type T3ThreadView } from "../../../apps/cli/src/t3/read.ts";
import { branchSlug, obLeaks } from "../src/clean-repo.ts";
import { formatReadyReport, type SpinoffRow } from "../src/commands/spinoff.ts";
import { noteErrorLine } from "../src/spinoff-gateable.ts";
import { sendBackSpinoff } from "../src/spinoff-sendback.ts";
import { formatSpikeReport } from "../src/spinoff-spike.ts";

const ROOT = join(import.meta.dir, "../../..");
const PLANNER = /planner/i;

const row = {
  id: 7,
  ticket_ref: "OB-7",
  branch: "ob-7",
  worktree: "/w/ob-7",
  status: "ready-for-gate",
  launcher: "t3",
  t3_thread_id: "builder-thread",
} as SpinoffRow;

describe("ob spinoff check --architect (OB-2256 Done when 3)", () => {
  test("--planner is refused by name, exit 2", async () => {
    const r = await runCli(freshDbPath(), ["spinoff", "check", "OB-1", "--planner", "{}", "--checker", "{}"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--planner");
  });
});

describe("handoff, gateable, show, sendback and spike text (OB-2256 Done when 4)", () => {
  test("the handoff report names the sentinel", () => {
    const text = formatReadyReport(row, "State: landable");
    expect(text).toContain("the sentinel gates and merges the PR");
    expect(text).not.toMatch(PLANNER);
  });

  test("the readying and spike notes never say planner", () => {
    const facts = { ticket: "OB-7", branch: "ob-7", worktree: "/w", rowId: 7, composedAt: "2026-11-17T00:00:00Z" };
    const notes = [
      readyingNote({ ...facts, commitsAhead: 1, state: "State: landable", builderNote: null, status: "ready-for-gate" }),
      spikeAnsweredNote(facts),
      spikeClosedNote({ ticket: "OB-7" }),
      formatSpikeReport(row),
      formatSpikeReport(row, { committed: true, prUrl: "https://example.test/pr/1" }),
    ];
    for (const n of notes) expect(n).not.toMatch(PLANNER);
    expect(formatSpikeReport(row)).toContain("the sentinel reads the answers");
  });

  test("the gateable and show note-error line, and the note outcomes, never say planner", () => {
    expect(noteErrorLine("2026-11-17T00:00:00Z T3 refused it")).toBe("  readying note: NOT delivered at 2026-11-17T00:00:00Z: T3 refused it");
    const failed = renderReadyNoteOutcome({ ticket: "OB-7", threadId: null, outcome: "failed", reason: "T3 down" });
    expect(failed.line).toContain("the readying note did not reach the sentinel and is held");
    expect(failed.line).not.toMatch(PLANNER);
  });

  test("the send-back message names the sentinel", async () => {
    const sent: string[] = [];
    await sendBackSpinoff(row, { flip: async () => {}, restore: async () => {}, send: async (_t, m) => void sent.push(m), headSha: () => "abc" }, "fix the test");
    expect(sent[0]).toContain("The sentinel gated your PR");
    expect(sent[0]).not.toMatch(PLANNER);
  });
});

describe("T3 labels a team role thread by its role (OB-2256 Done when 5)", () => {
  const PROJECT: T3Project = {
    id: "p",
    title: "slash",
    workspaceRoot: "/r/slash",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    deletedAt: null,
  };
  const index = indexT3Rows({
    spinoffs: [],
    agents: [
      { id: "architect-slash", ticket: null, branch: "main", worktree: "/r", launcher: "t3", session_id: "t-a" },
      { id: "sentinel-slash", ticket: null, branch: "main", worktree: "/r", launcher: "t3", session_id: "t-s" },
      { id: "muse-slash", ticket: null, branch: "main", worktree: "/r", launcher: "t3", session_id: "t-m" },
      { id: "planner-slash", ticket: null, branch: "main", worktree: "/r", launcher: "t3", session_id: "t-p" },
    ],
  });

  test("each role row joins with its own role as the kind; a planner-* row is not a team thread", () => {
    expect(index.get("t-a")?.kind).toBe("architect");
    expect(index.get("t-s")?.kind).toBe("sentinel");
    expect(index.get("t-m")?.kind).toBe("muse");
    expect(index.has("t-p")).toBe(false);
  });

  test("ob t3 tree prints the role, and status prints the role's agent id", () => {
    const view = (threadId: string): T3ThreadView => ({
      threadId,
      projectId: "p",
      project: "slash",
      title: threadId,
      status: "idle",
      settled: false,
      pendingRequestCount: 0,
      worktreePath: null,
      branch: null,
      parentThreadId: null,
      relationshipToParent: null,
      updatedAt: null,
      ob: index.get(threadId) ?? null,
      link: "l",
    });
    const threads = ["t-a", "t-s", "t-m"].map(view);
    const text = renderT3Tree(buildT3Tree([PROJECT], threads));
    for (const role of ["architect", "sentinel", "muse"]) expect(text).toContain(`[${role}]`);
    expect(text).not.toMatch(PLANNER);
    expect(threadObLabel(threads[1]!)).toBe("sentinel-slash");
  });
});

describe("the clean-repo guard (OB-2256 Done when 6)", () => {
  test("a branch, subject or body carrying a team role or planner is refused", () => {
    for (const word of ["architect", "sentinel", "muse", "planner"]) {
      expect(obLeaks(`fix(web): ask the ${word} first`)).toEqual([{ kind: "word", match: word }]);
      expect(branchSlug(`ask the ${word} first`)).toBe("ask-the-first");
    }
    expect(obLeaks("fix(web): the architecture of the cache")).toEqual([]);
  });
});

describe("help, README and skills (OB-2256 Done when 2 and 7)", () => {
  test("ob --help and apps/cli/README.md say architect, never planner", () => {
    expect(HELP).not.toMatch(PLANNER);
    expect(renderEnvHelp()).not.toMatch(PLANNER);
    for (const [cmd, spec] of Object.entries(COMMAND_HELP)) {
      expect(renderCommandHelp(cmd)).not.toMatch(PLANNER);
      for (const sub of Object.keys(spec.subcommands ?? {})) {
        expect(renderSubcommandHelp(cmd, sub)).not.toMatch(PLANNER);
      }
    }
    expect(renderSubcommandHelp("spinoff", "check")).toContain("--architect");
    const readme = readFileSync(join(ROOT, "apps/cli/README.md"), "utf8");
    expect(readme).not.toMatch(PLANNER);
  });

});

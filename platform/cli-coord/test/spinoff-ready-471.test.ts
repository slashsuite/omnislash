import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import {
  enqueueSpinoff,
  formatReadyReport,
  type EnqueueInput,
  type SpinoffRow,
} from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";
import { registerAgent } from "../src/agent.ts";
import { assessGateable, isLandable } from "../src/spinoff-gateable.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const README = cliDocs();

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "471",
  repo: "/r/omnislash",
  branch: "471",
  mode: "interactive",
  brief: "ready is the land yes",
  ...over,
});

async function seedLaunched(
  db: ReturnType<typeof openDb>,
  worktree: string,
): Promise<SpinoffRow> {
  const { row } = await enqueueSpinoff(db, input({ worktree }));
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ? WHERE id = ?").run(
    "471",
    worktree,
    row.id,
  );
  await registerAgent(db, { id: "471", ticket: "471", branch: "471", worktree, status: "working", ttlS: 900 });
  return { ...row, status: "launched", agent_id: "471", worktree };
}

describe("isLandable, the one predicate (471, OB-1924)", () => {
  const cases: Array<[string, string | null, boolean, boolean]> = [
    // label, state, landable when not handed off, landable when handed off
    ["landable", "State: landable — gate green", true, true],
    ["the ready alias", "State: ready — gated", true, true],
    ["needs-human", "State: needs-human — look", false, true],
    ["bare needs-human", "State: needs-human", false, true],
    ["blocked", "State: blocked", false, false],
    ["partial", "State: partial — wip", false, false],
    ["ready-for-gate is prose, not a verdict word", "State: ready-for-gate", false, false],
    ["missing", null, false, false],
    ["empty", "", false, false],
  ];
  for (const [label, state, notHandedOff, handedOff] of cases) {
    test(label, () => {
      expect(isLandable(state, { handedOff: false })).toBe(notHandedOff);
      expect(isLandable(state, { handedOff: true })).toBe(handedOff);
    });
  }

  test("assessGateable for a ready-for-gate row with needs-human is landable", () => {
    const row = assessGateable(
      { id: 1, ticket_ref: "471", branch: "471", worktree: "/wt/471", repo: "/r/omnislash" },
      { missing: false, state: "State: needs-human — look", paths: ["apps/cli/src/cli.ts"] },
    );
    expect(row.landable).toBe(true);
  });

  test("blocked / partial / missing State / missing worktree are not landable", () => {
    const src = { id: 1, ticket_ref: "471", branch: "471", worktree: "/wt/471", repo: "/r/omnislash" };
    expect(assessGateable(src, { missing: false, state: "State: blocked", paths: ["a.ts"] }).landable).toBe(false);
    expect(assessGateable(src, { missing: false, state: "State: partial — wip", paths: ["a.ts"] }).landable).toBe(false);
    expect(assessGateable(src, { missing: false, state: null, paths: ["a.ts"] }).landable).toBe(false);
    expect(assessGateable(src, { missing: true, state: "State: needs-human", paths: ["a.ts"] }).landable).toBe(false);
  });
});

describe("formatReadyReport (471)", () => {
  const row = { ticket_ref: "471", branch: "471", worktree: "/wt/471" } as SpinoffRow;

  test("needs-human says landable: yes and the architect land line", () => {
    const text = formatReadyReport(row, "State: needs-human — look", false);
    expect(text).toContain("landable: yes");
    expect(text).toContain("next:      the sentinel gates and merges the PR (the handoff is the human yes)");
  });

  test("ready says the same wake lines", () => {
    const text = formatReadyReport(row, "State: ready — gated", false);
    expect(text).toContain("landable: yes");
    expect(text).toContain("next:      the sentinel gates and merges the PR (the handoff is the human yes)");
  });

  test("blocked / missing State are not landable", () => {
    expect(formatReadyReport(row, "State: blocked", false)).toContain("landable: no");
    expect(formatReadyReport(row, null, false)).toContain("landable: no");
  });
});

describe("ob spinoff ready refuses a dirty worktree (471)", () => {
  test("inject git status — prints dirty paths, does not stamp ready-for-gate", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-471-"));
    await seedLaunched(db, wt);
    const restore = __setSh((cmd) => {
      if (cmd.includes("status") && cmd.includes("--porcelain")) {
        return { ok: true, err: "", out: " M apps/cli/src/dle.ts\n?? leftover.ts\n" };
      }
      return { ok: true, err: "", out: "State: needs-human — look\n" };
    });
    try {
      const r = await runCli(dbPath, ["spinoff", "ready", "471"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("worktree is dirty");
      expect(r.err).toContain("do not invent a commit");
      expect(r.err).toContain("apps/cli/src/dle.ts");
      expect(r.err).toContain("leftover.ts");
      const listed = db.query("SELECT status FROM spinoff WHERE ticket_ref = '471'").get() as { status: string };
      expect(listed.status).toBe("launched");
    } finally {
      restore();
      db.close();
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("clean porcelain still stamps ready-for-gate", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-471-clean-"));
    await seedLaunched(db, wt);
    const restore = __setSh((cmd) => {
      if (cmd.includes("status") && cmd.includes("--porcelain")) {
        return { ok: true, err: "", out: "" };
      }
      return { ok: true, err: "", out: "State: needs-human — look\n" };
    });
    try {
      const r = await runCli(dbPath, ["spinoff", "ready", "471"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("471 handed off");
      expect(r.out).toContain("landable: yes");
      expect(r.out).toContain("next:      the sentinel gates and merges the PR (the handoff is the human yes)");
      expect(r.out).toContain("State: needs-human");
    expect(r.out).toContain("🙋 needs you: look");
    } finally {
      restore();
      db.close();
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("docs (471)", () => {
  test("HELP and README name dirty refuse and needs-human landable", () => {
    const help = renderSubcommandHelp("spinoff", "handoff");
    expect(help).toContain("spinoff ready");
    expect(README).toContain("spinoff ready");
    expect(help).toContain("dirty worktrees");
    expect(README).toContain("Refuses if the worktree is dirty");
    expect(README).toContain("gate and merge the PR (the handoff is the human yes)");
    expect(help).toContain("needs-human");
    expect(README).toContain("needs-human");
    expect(README).toContain("amends 442");
  });
});

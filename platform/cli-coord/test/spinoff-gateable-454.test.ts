import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import {
  enqueueSpinoff,
  gateableFactsFor,
  readChangedPaths,
  __setSh,
  type EnqueueInput,
} from "../src/commands/spinoff.ts";
import {
  REBUILD_CLI,
  REBUILD_CLI_DB,
  REBUILD_CLOSE_ONLY,
  REBUILD_DASHBOARD,
  REBUILD_MISSING,
  REBUILD_NONE,
  REBUILD_OPS,
  assessGateable,
  isLandable,
  rebuildAdvice,
  renderGateableList,
  reportGateable,
  type GateableSource,
} from "../src/spinoff-gateable.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const README = cliDocs();

/** A path under an app the rebuild table does NOT know: reported by name, never guessed at (454). */
const REBUILD_WIDGET = "apps/widget";

const src = (over: Partial<GateableSource> = {}): GateableSource => ({
  id: 1,
  ticket_ref: "454",
  branch: "454",
  worktree: "/wt/454",
  repo: "/r/acme",
  ...over,
});

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "454",
  repo: "/r/acme",
  branch: "454",
  mode: "interactive",
  brief: "gateable",
  worktree: "/wt/454",
  ...over,
});

async function seedReady(
  db: ReturnType<typeof openDb>,
  over: Partial<EnqueueInput> = {},
): Promise<{ id: number; ticket_ref: string; worktree: string }> {
  const { row } = await enqueueSpinoff(db, input(over));
  db.query("UPDATE spinoff SET status = 'ready-for-gate' WHERE id = ?").run(row.id);
  return row;
}

describe("isLandable punctuation (454)", () => {
  test("trailing punctuation after the verdict word is not part of the token (1618)", () => {
    expect(isLandable("State: landable: gate green", { handedOff: false })).toBe(true);
    expect(isLandable("State: landable, gate green", { handedOff: false })).toBe(true);
    expect(isLandable("State: ready: gated", { handedOff: false })).toBe(true);
    expect(isLandable("State: blocked: waiting", { handedOff: false })).toBe(false);
    expect(isLandable("State: needs-human: look", { handedOff: true })).toBe(true);
  });
});

describe("rebuildAdvice locked path table (454)", () => {
  test("unknown app paths", () => {
    expect(rebuildAdvice(["apps/widget/src/App.swift"], { missing: false })).toEqual([REBUILD_WIDGET]);
  });

  test("cli db vs other cli", () => {
    expect(rebuildAdvice(["apps/cli/src/db/schema.ts"], { missing: false })).toEqual([REBUILD_CLI_DB]);
    expect(rebuildAdvice(["platform/cli-db/test/db-migration.e2e.test.ts"], { missing: false })).toEqual([REBUILD_CLI_DB]);
    expect(rebuildAdvice(["apps/cli/src/cli.ts"], { missing: false })).toEqual([REBUILD_CLI]);
    expect(rebuildAdvice(["platform/cli-core/test/items.test.ts"], { missing: false })).toEqual([REBUILD_CLI]);
  });

  test("several prefixes list every matching rebuild", () => {
    expect(
      rebuildAdvice(
        ["apps/widget/x.ts", "apps/cli/src/db/m.sql", "apps/cli/src/cli.ts", "apps/dashboard/p.tsx", "ops/deploy.sh"],
        { missing: false },
      ),
    ).toEqual([REBUILD_WIDGET, REBUILD_CLI_DB, REBUILD_CLI, REBUILD_DASHBOARD, REBUILD_OPS]);
  });

  test("unknown apps/<x>/ names the project path and does not invent a target", () => {
    expect(rebuildAdvice(["apps/stayawake/src/a.ts"], { missing: false })).toEqual(["apps/stayawake"]);
    expect(rebuildAdvice(["apps/stayawake/src/a.ts"], { missing: false })[0]).not.toMatch(/nx |moon /);
  });

  test("skills/wayfinder only is none; empty is close only", () => {
    expect(rebuildAdvice(["docs/map.md", "skills/ob-land/SKILL.md"], { missing: false })).toEqual([REBUILD_NONE]);
    expect(rebuildAdvice([], { missing: false })).toEqual([REBUILD_CLOSE_ONLY]);
  });

  test("missing worktree wins", () => {
    expect(rebuildAdvice(["apps/widget/x.ts"], { missing: true })).toEqual([REBUILD_MISSING]);
  });
});

describe("assessGateable injected name-only lists (454)", () => {
  test("empty list renders and is exit-friendly", () => {
    expect(renderGateableList([], "human")).toBe("no gateable spinoffs");
    expect(renderGateableList([], "json")).toBe("[]");
    expect(renderGateableList([], "quiet")).toBe("");
  });

  test("OS-177: a row prints its score as complexity N/10, and a NULL score reads its tier's alias value", () => {
    const facts = { missing: false, state: "State: landable", paths: [] };
    const scored = renderGateableList([assessGateable(src({ complexity: 3, tier: "simple", model: "m" }), facts)], "human");
    expect(scored).toContain("  complexity 3/10 · model: m");
    const legacy = renderGateableList([assessGateable(src({ complexity: null, tier: "complex" }), facts)], "human");
    expect(legacy).toContain("  complexity 8/10 · model: -");
  });

  test("one ready landable with unknown-app paths", () => {
    const row = assessGateable(src(), {
      missing: false,
      state: "State: ready — gated",
      paths: ["apps/widget/src/App.swift"],
    });
    expect(row.landable).toBe(true);
    expect(row.rebuild).toEqual([REBUILD_WIDGET]);
    expect(row.ticket).toBe("454");
    expect(row.id).toBe(1);
    expect(row.branch).toBe("454");
    expect(row.worktree).toBe("/wt/454");
    expect(row.repo).toBe("/r/acme");
    expect(row.state).toBe("State: ready — gated");
  });

  test("one ready empty-diff is close only", () => {
    const row = assessGateable(src({ ticket_ref: "412" }), {
      missing: false,
      state: "State: ready — nothing to merge",
      paths: [],
    });
    expect(row.landable).toBe(true);
    expect(row.rebuild).toEqual([REBUILD_CLOSE_ONLY]);
  });

  test("State: needs-human on a ready-for-gate row is landable (471)", () => {
    const row = assessGateable(src({ ticket_ref: "99" }), {
      missing: false,
      state: "State: needs-human — look at the sidebar",
      paths: ["apps/cli/src/cli.ts"],
    });
    expect(row.landable).toBe(true);
    expect(row.state).toBe("State: needs-human — look at the sidebar");
    expect(row.rebuild).toEqual([REBUILD_CLI]);
  });

  test("missing worktree still lists the row", () => {
    const row = assessGateable(src({ worktree: "/gone/wt" }), {
      missing: true,
      state: "State: ready",
      paths: ["apps/widget/x.ts"],
    });
    expect(row.landable).toBe(false);
    expect(row.state).toBeNull();
    expect(row.paths).toEqual([]);
    expect(row.rebuild).toEqual([REBUILD_MISSING]);
  });
});

describe("readChangedPaths injects name-only lists (454)", () => {
  test("uses main...branch when main exists", () => {
    const restore = __setSh((cmd) => {
      if (cmd.includes("--is-ancestor")) return { ok: true, err: "", out: "" }; // (1490) origin/main is behind local main: local wins
      if (cmd.includes("rev-parse")) return { ok: true, err: "", out: "abc\n" };
      if (cmd.includes("diff") && cmd.some((c) => String(c).includes("main...454"))) {
        return { ok: true, err: "", out: "apps/widget/src/App.swift\n" };
      }
      return { ok: false, err: "unexpected", out: "" };
    });
    try {
      expect(readChangedPaths("/wt", "454", "deadbeef")).toEqual(["apps/widget/src/App.swift"]);
    } finally {
      restore();
    }
  });

  test("falls back to base_sha when main is missing", () => {
    const restore = __setSh((cmd) => {
      if (cmd.includes("rev-parse")) return { ok: false, err: "needed a single revision", out: "" };
      if (cmd.includes("diff") && cmd.some((c) => String(c).includes("deadbeef...454"))) {
        return { ok: true, err: "", out: "apps/cli/src/cli.ts\n" };
      }
      return { ok: false, err: "unexpected", out: "" };
    });
    try {
      expect(readChangedPaths("/wt", "454", "deadbeef")).toEqual(["apps/cli/src/cli.ts"]);
    } finally {
      restore();
    }
  });
});

describe("gateableFactsFor missing worktree (454)", () => {
  test("does not throw when the worktree is gone", () => {
    expect(gateableFactsFor({ ...src({ worktree: "/no/such/wt-454" }), base_sha: null })).toEqual({
      missing: true,
      state: null,
      paths: [],
    });
  });
});

describe("ob spinoff gateable CLI (454)", () => {
  test("empty list exits 0", async () => {
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["spinoff", "gateable"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no gateable spinoffs");
    const json = await runCli(dbPath, ["spinoff", "gateable", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual([]);
    const quiet = await runCli(dbPath, ["spinoff", "gateable", "-q"]);
    expect(quiet.code).toBe(0);
    expect(quiet.out).toBe("");
  });

  test("lists ready-for-gate rows from injected git name-only lists", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const wt454 = mkdtempSync(join(tmpdir(), "ob-wt-454-"));
    const wt412 = mkdtempSync(join(tmpdir(), "ob-wt-412-"));
    const wt99 = mkdtempSync(join(tmpdir(), "ob-wt-99-"));
    await seedReady(db, { ticketRef: "454", branch: "454", worktree: wt454 });
    await seedReady(db, { ticketRef: "412", branch: "412", worktree: wt412 });
    await seedReady(db, { ticketRef: "99", branch: "99", worktree: wt99 });
    await seedReady(db, { ticketRef: "7", branch: "7", worktree: "/gone/wt-7" });
    const restore = __setSh((cmd) => {
      const wt = String(cmd[cmd.indexOf("-C") + 1] ?? "");
      if (cmd.includes("rev-parse")) return { ok: true, err: "", out: "abc\n" };
      if (cmd.includes("log")) {
        if (wt === wt454) return { ok: true, err: "", out: "State: ready — gated\n" };
        if (wt === wt412) return { ok: true, err: "", out: "State: ready — nothing to merge\n" };
        if (wt === wt99) return { ok: true, err: "", out: "State: needs-human — look\n" };
        return { ok: true, err: "", out: "" };
      }
      if (cmd.includes("diff")) {
        if (wt === wt454) return { ok: true, err: "", out: "apps/widget/src/App.swift\n" };
        return { ok: true, err: "", out: "" };
      }
      return { ok: true, err: "", out: "" };
    });
    try {
      const r = await runCli(dbPath, ["spinoff", "gateable"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("454");
      expect(r.out).toContain("412");
      expect(r.out).toContain("99");
      expect(r.out).toContain("7");
      expect(r.out).toContain("worktree missing");
      expect(r.out).toContain(REBUILD_WIDGET);
      expect(r.out).toContain(REBUILD_CLOSE_ONLY);
      const json = JSON.parse((await runCli(dbPath, ["spinoff", "gateable", "--json"])).out) as Array<{
        ticket: string;
        landable: boolean;
        rebuild: string[];
      }>;
      const byTicket = Object.fromEntries(json.map((row) => [row.ticket, row]));
      expect(byTicket["454"]?.landable).toBe(true);
      expect(byTicket["454"]?.rebuild).toEqual([REBUILD_WIDGET]);
      expect(byTicket["412"]?.landable).toBe(true);
      expect(byTicket["412"]?.rebuild).toEqual([REBUILD_CLOSE_ONLY]);
      expect(byTicket["99"]?.landable).toBe(true);
      expect(byTicket["7"]?.rebuild).toEqual([REBUILD_MISSING]);
      expect(byTicket["7"]?.landable).toBe(false);
      const quiet = await runCli(dbPath, ["spinoff", "gateable", "-q"]);
      expect(quiet.out.trim().split("\n").sort()).toEqual(["412", "454", "7", "99"].sort());
    } finally {
      restore();
      db.close();
      rmSync(wt454, { recursive: true, force: true });
      rmSync(wt412, { recursive: true, force: true });
      rmSync(wt99, { recursive: true, force: true });
    }
  });

  test("launched rows are not listed", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const { row } = await enqueueSpinoff(db, input({ ticketRef: "pending-only", branch: "p", worktree: "/wt/p" }));
    db.query("UPDATE spinoff SET status = 'launched' WHERE id = ?").run(row.id);
    try {
      const r = await runCli(dbPath, ["spinoff", "gateable", "--json"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("docs (454)", () => {
  test("HELP and README name spinoff gateable", () => {
    const help = renderSubcommandHelp("spinoff", "gateable");
    expect(help).toContain("spinoff gateable");
    expect(README).toContain("spinoff gateable");
    expect(help).toContain("locked path table");
    expect(README).toContain("locked path table");
  });
});

describe("reportGateable injects name-only lists (454)", () => {
  test("covers the five ticket cases in one pass", () => {
    const rows: GateableSource[] = [
      src({ id: 1, ticket_ref: "454", worktree: "/wt/454" }),
      src({ id: 2, ticket_ref: "412", branch: "412", worktree: "/wt/412" }),
      src({ id: 3, ticket_ref: "99", branch: "99", worktree: "/wt/99" }),
      src({ id: 4, ticket_ref: "7", branch: "7", worktree: "/gone/wt" }),
    ];
    const text = reportGateable(rows, (row) => {
      if (row.worktree.startsWith("/gone")) return { missing: true, state: null, paths: [] };
      if (row.ticket_ref === "454") {
        return { missing: false, state: "State: ready — gated", paths: ["apps/widget/src/App.swift"] };
      }
      if (row.ticket_ref === "412") return { missing: false, state: "State: ready", paths: [] };
      return { missing: false, state: "State: needs-human — look", paths: ["apps/cli/src/cli.ts"] };
    }, "human");
    expect(text).toContain("landable: yes");
    expect(text).toContain("landable: no");
    expect(text).toContain(REBUILD_WIDGET);
    expect(text).toContain(REBUILD_CLOSE_ONLY);
    expect(text).toContain(REBUILD_MISSING);
    expect(text).toContain("State: needs-human");
    expect(text).toContain("🙋 needs you: look");
  });
});

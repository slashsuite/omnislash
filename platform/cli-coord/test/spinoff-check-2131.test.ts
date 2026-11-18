// OB-2131: the blind check gates on questions only. Scores, the gap, a 0 and disjoint file lists are printed as
// `read:` lines and stored; only an unresolved checker question refuses. Each question gets a recorded resolution
// (`--resolutions`), stored beside a checker sheet that stays as received. `ob spinoff gateable` and `show` print a
// `files:` line: the go check's planned files against the branch diff. In-process against a fresh SQLite database,
// a fake T3 and the `sh` seam: no network, no live store.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRepoDir, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { eventsForItemFor, parsePayload } from "../../../apps/cli/src/events.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { __setSh, rewriteSpinoffRepoArgv } from "../src/commands/spinoff.ts";
import { compareFiles, filesLine } from "../src/spinoff-files.ts";
import { plannedFilesOf } from "../src/spinoff-check.ts";

const READY = "Need stated.\n\n## Drilled\n- cause read in the code\n\n## Done when\n- a test shows it";
const ALL_TWO = { problem: 2, scope: 2, done: 2, design: 2, proof: 2, unknowns: 2, size: 2 };
const side = (over: Record<string, unknown> = {}) => ({
  does: "Adds a gate.",
  files: ["platform/cli-coord/src/spinoff-check.ts"],
  questions: [],
  scores: ALL_TWO,
  ...over,
});
const sheets = (architect = side(), checker = side()) => ["--architect", JSON.stringify(architect), "--checker", JSON.stringify(checker)];

async function ticket(): Promise<{ dbPath: string; id: string; repo: string }> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath);
  const id = await createItem(db, { type: "task", title: "gated", body: READY });
  db.close();
  return { dbPath, id, repo: fakeRepoDir() };
}

async function lastCheck(dbPath: string, id: string): Promise<Record<string, any>> {
  const db = openDb(dbPath);
  const [event] = await eventsForItemFor(db, id, 1, { source: "ob", type: "transition" });
  db.close();
  return parsePayload<Record<string, any>>(event!);
}

async function dispatch(dbPath: string, id: string, repo: string, wt: string) {
  const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
  const t3 = installFakeT3([repo]);
  try {
    const r = await runCli(dbPath, ["spinoff", id, "--repo", repo, "--branch", `build-${id}`, "--worktree", wt, "--brief", "b"]);
    return { ...r, launches: t3.launches.length };
  } finally {
    t3.restore();
    restoreSh();
  }
}

// The architect at 57: seven criteria, six at 1 and one at 2 (8 of 14), each low one explained.
const LOW_SCORES = { problem: 1, scope: 1, done: 1, design: 1, proof: 1, unknowns: 1, size: 2 };
const LOW_WHY = Object.fromEntries(["problem", "scope", "done", "design", "proof", "unknowns"].map((c) => [c, { why: "thin", raises: "read more" }]));

describe("the verdict gates on questions only (OB-2131)", () => {
  test("architect 57, checker 100, no questions: go, read lines for the score and the gap, exit 0, and the gate dispatches", async () => {
    const { dbPath, id, repo } = await ticket();
    const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(side({ scores: LOW_SCORES, low: LOW_WHY }), side())]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("go:");
    expect(r.out).toContain("read: architect scored 57, under 70");
    expect(r.out).toContain("read: scores are 43 apart, over 15");
    const payload = await lastCheck(dbPath, id);
    expect(payload.to).toBe("go");
    expect(payload.read).toEqual(["architect scored 57, under 70", "scores are 43 apart, over 15"]);
    const wt = mkdtempSync(join(tmpdir(), "ob-2131-"));
    try {
      const launched = await dispatch(dbPath, id, repo, wt);
      expect(launched.err).not.toContain("not dispatched");
      expect(launched.code).toBe(0);
      expect(launched.launches).toBe(1);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("two checker questions and no --resolutions: no-go, both texts printed, exit 1, and the gate refuses", async () => {
    const { dbPath, id, repo } = await ticket();
    const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(side(), side({ questions: ["which table holds it?", "what about old rows?"] }))]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no-go:");
    expect(r.out).toContain("question 1: which table holds it?");
    expect(r.out).toContain("question 2: what about old rows?");
    const wt = mkdtempSync(join(tmpdir(), "ob-2131-"));
    try {
      const refused = await dispatch(dbPath, id, repo, wt);
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("'no-go'");
      expect(refused.launches).toBe(0);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("--json carries read and resolutions", async () => {
    const { dbPath, id } = await ticket();
    const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(side(), side({ files: ["elsewhere.ts"] })), "--json"]);
    const res = JSON.parse(r.out);
    expect(res.verdict).toBe("go");
    expect(res.read).toEqual(["the two file lists share no path"]);
    expect(res.resolutions).toEqual([]);
  });
});

describe("--resolutions (OB-2131)", () => {
  const QUESTIONS = ["which table holds it?", "is the old flag kept?"];
  const RESOLVED = [
    { q: 1, how: "edit", note: "Drilled now names the spinoff table" },
    { q: 2, how: "dismiss", note: "refused by name; the ticket already says so" },
  ];

  test("one edit and one dismiss: go, the checker sheet stored byte for byte, the resolutions beside it", async () => {
    const { dbPath, id } = await ticket();
    const checker = side({ does: "checker's own words", questions: QUESTIONS, extra_field: { kept: true } });
    const dir = mkdtempSync(join(tmpdir(), "ob-2131-res-"));
    const file = join(dir, "resolutions.json");
    writeFileSync(file, JSON.stringify(RESOLVED));
    try {
      const r = await runCli(dbPath, ["spinoff", "check", id, "--architect", JSON.stringify(side()), "--checker", JSON.stringify(checker), "--resolutions", file]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("go:");
      const payload = await lastCheck(dbPath, id);
      expect(JSON.stringify(payload.checker)).toBe(JSON.stringify(checker));
      expect(payload.resolutions).toEqual(RESOLVED);
      expect(payload.questions_resolved).toBe(true);
      expect(payload.to).toBe("go");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const refusals: Array<[string, unknown, string]> = [
    ["a missing index", [RESOLVED[0]], "missing question 2"],
    ["an index out of order", [RESOLVED[1], RESOLVED[0]], "question 1 is missing or out of order"],
    ["an extra index", [...RESOLVED, { q: 3, how: "edit", note: "x" }], "extra index: q 3"],
    ["an empty note", [RESOLVED[0], { q: 2, how: "dismiss", note: "  " }], "empty note"],
    ["an unknown how", [RESOLVED[0], { q: 2, how: "ignore", note: "x" }], 'how "ignore"'],
    ["not a list", { q: 1 }, "must be a JSON list"],
  ];
  for (const [label, value, needle] of refusals) {
    test(`${label} is refused by name and records nothing`, async () => {
      const { dbPath, id } = await ticket();
      const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(side(), side({ questions: QUESTIONS })), "--resolutions", JSON.stringify(value)]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(needle);
      expect(r.err).toContain("Nothing was recorded");
      const db = openDb(dbPath);
      expect(await eventsForItemFor(db, id, 5, { source: "ob", type: "transition" })).toHaveLength(0);
      db.close();
    });
  }

  test("zero questions: absent and [] are both go, a non-empty list is an extra index", async () => {
    const { dbPath, id } = await ticket();
    expect((await runCli(dbPath, ["spinoff", "check", id, ...sheets(), "--resolutions", "[]"])).code).toBe(0);
    const extra = await runCli(dbPath, ["spinoff", "check", id, ...sheets(), "--resolutions", JSON.stringify([RESOLVED[0]])]);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain("extra index: q 1");
  });

  test("--questions-resolved is refused with the replacement message", async () => {
    const { dbPath, id } = await ticket();
    const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(), "--questions-resolved"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--questions-resolved is replaced by --resolutions (one entry per checker question); see 'ob --help'");
  });
});

describe("--resolutions over the API (OB-2131)", () => {
  test("the client inlines a --resolutions file into the argv it sends", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-2131-api-"));
    const file = join(dir, "r.json");
    writeFileSync(file, JSON.stringify([{ q: 1, how: "edit", note: "n" }]));
    try {
      const argv = ["spinoff", "check", "OB-1", "--architect", "{}", "--checker", "{}", "--resolutions", file];
      const out = rewriteSpinoffRepoArgv({ argv, command: "spinoff", args: ["check", "OB-1"], flags: {}, db: openDb(freshDbPath()) });
      expect(out.error).toBeNull();
      expect(JSON.parse(out.argv[out.argv.indexOf("--resolutions") + 1]!)).toEqual([{ q: 1, how: "edit", note: "n" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ob spinoff check over a stubbed transport sends the resolutions in the POST body", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const transport: ApiTransport = async (req: ApiRequest) => {
      const body = req.body ? JSON.parse(req.body) : {};
      bodies.push(body);
      return {
        status: 200,
        body: JSON.stringify({ ticket: "OB-1", verdict: "go", reasons: [], read: [], resolutions: body.resolutions, unresolved: [], architect_pct: 100, checker_pct: 100, gap: 0, low_criteria: [], shared_files: [], body_sha256: "0".repeat(64), questions_resolved: true }),
      };
    };
    const resolutions = [{ q: 1, how: "dismiss", note: "not needed" }];
    const r = await runCli(freshDbPath(), ["spinoff", "check", "OB-1", ...sheets(side(), side({ questions: ["q?"] })), "--resolutions", JSON.stringify(resolutions)], {
      api: { base: "https://ob.example.test", token: "t", transport },
    });
    expect(r.code).toBe(0);
    expect(bodies.at(-1)).toMatchObject({ ticket_ref: "OB-1", resolutions });
  });

  test("the server's POST /spinoffs/check stores the resolutions, and /spinoffs/planned-files reads the go check back", async () => {
    const { dbPath, id } = await ticket();
    const store = asStore(openDb(dbPath));
    const TOKEN = "a-test-bearer-token-that-is-long-enough";
    const app = createObApi({ store: async () => store, token: () => ({ token: TOKEN, path: "/nowhere", reason: null, message: null }) });
    const post = async (path: string, body: unknown) => {
      const res = await app(
        new Request(`http://host.test${OB_API_PREFIX}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: res.status, body: (await res.json()) as any };
    };
    const resolutions = [{ q: 1, how: "edit", note: "answered in Drilled" }];
    const checked = await post("/spinoffs/check", { ticket_ref: id, architect: side({ files: ["a.ts"] }), checker: side({ files: ["b.ts", "dir/"], questions: ["q?"] }), resolutions });
    expect(checked.status).toBe(200);
    expect(checked.body.verdict).toBe("go");
    expect((await lastCheck(dbPath, id)).resolutions).toEqual(resolutions);
    const planned = await post("/spinoffs/planned-files", { rows: [{ id: 7, ticket_ref: id, item_id: null }, { id: 8, ticket_ref: "ZZ-404", item_id: null }] });
    expect(planned.body).toEqual({ planned: [{ id: 7, files: ["a.ts", "b.ts"] }, { id: 8, files: null }] });
  });
});

describe("the files: line (OB-2131)", () => {
  test("compareFiles and filesLine, pure", () => {
    expect(filesLine(compareFiles(["a", "b", "c", "d"], ["a", "x", "y"], false))).toBe(
      "files: 1 of 4 planned touched, 2 unplanned (read why: under half the planned files touched)",
    );
    expect(filesLine(compareFiles(["a", "b", "c", "d"], ["a", "b"], false))).toBe("files: 2 of 4 planned touched, 0 unplanned");
    expect(filesLine(compareFiles(null, ["a"], false))).toBe("files: no go check");
    expect(filesLine(compareFiles([], ["a"], false))).toBe("files: no planned files on the go check");
    expect(filesLine(compareFiles(["a"], [], false))).toBe("files: no diff to compare");
    expect(filesLine(compareFiles(["a"], ["a"], true))).toBe("files: no diff to compare");
  });

  test("plannedFilesOf unions both sheets, normalised, leaving out directories and globs", () => {
    expect(plannedFilesOf({ planner: { files: ["./a.ts:12", "apps/"] }, checker: { files: ["`b.ts`", "a.ts", "*.md"] } })).toEqual(["a.ts", "b.ts"]);
  });

  /** A handed-off row whose worktree exists, its branch diff answered by the `sh` seam. */
  async function gatedRow(architectFiles: string[] | null, checkerFiles: string[] = []) {
    const { dbPath, id, repo } = await ticket();
    const wt = mkdtempSync(join(tmpdir(), "ob-2131-wt-"));
    if (architectFiles) {
      expect((await runCli(dbPath, ["spinoff", "check", id, ...sheets(side({ files: architectFiles }), side({ files: checkerFiles }))])).code).toBe(0);
    }
    const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
    const t3 = installFakeT3([repo]);
    try {
      const args = ["spinoff", id, "--repo", repo, "--branch", `build-${id}`, "--worktree", wt, "--brief", "b", ...(architectFiles ? [] : ["--no-check", "seed a row with no check"])];
      expect((await runCli(dbPath, args)).code).toBe(0);
    } finally {
      t3.restore();
      restoreSh();
    }
    const db = openDb(dbPath);
    db.query("UPDATE spinoff SET status = 'ready-for-gate'").run();
    db.close();
    return { dbPath, id, wt };
  }

  async function withDiff<T>(changed: string[], fn: () => Promise<T>): Promise<T> {
    const restore = __setSh((cmd) => {
      if (cmd.includes("diff") && cmd.includes("--name-only")) return { ok: true, err: "", out: changed.join("\n") + "\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      return await fn();
    } finally {
      restore();
    }
  }

  const WANT = "files: 1 of 4 planned touched, 2 unplanned (read why: under half the planned files touched)";

  test("gateable and show print the comparison, and --json carries the three lists", async () => {
    const { dbPath, id, wt } = await gatedRow(["a.ts", "b.ts", "c.ts"], ["d.ts", "a.ts"]);
    try {
      await withDiff(["a.ts", "x.ts", "y.ts"], async () => {
        const gateable = await runCli(dbPath, ["spinoff", "gateable"]);
        expect(gateable.out).toContain(`  ${WANT}`);
        const show = await runCli(dbPath, ["spinoff", "show", id]);
        expect(show.out).toContain(`  ${WANT}`);
        const want = { planned: ["a.ts", "b.ts", "c.ts", "d.ts"], touched: ["a.ts"], unplanned: ["x.ts", "y.ts"] };
        expect(JSON.parse((await runCli(dbPath, ["spinoff", "gateable", "--json"])).out)[0].files).toMatchObject(want);
        expect(JSON.parse((await runCli(dbPath, ["spinoff", "show", id, "--json"])).out).files).toMatchObject(want);
      });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("all planned files touched has no read-why marker", async () => {
    const { dbPath, wt } = await gatedRow(["a.ts", "b.ts"]);
    try {
      await withDiff(["a.ts", "b.ts"], async () => {
        expect((await runCli(dbPath, ["spinoff", "gateable"])).out).toContain("  files: 2 of 2 planned touched, 0 unplanned\n");
      });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("a row with no go check prints `files: no go check`", async () => {
    const { dbPath, id, wt } = await gatedRow(null);
    try {
      await withDiff(["a.ts"], async () => {
        expect((await runCli(dbPath, ["spinoff", "gateable"])).out).toContain("  files: no go check");
        expect((await runCli(dbPath, ["spinoff", "show", id])).out).toContain("  files: no go check");
      });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("a go check listing only directories and globs prints `files: no planned files on the go check`", async () => {
    const { dbPath, id, wt } = await gatedRow(["apps/cli/"], ["platform/*.ts"]);
    try {
      await withDiff(["a.ts"], async () => {
        expect((await runCli(dbPath, ["spinoff", "gateable"])).out).toContain("  files: no planned files on the go check");
        expect((await runCli(dbPath, ["spinoff", "show", id])).out).toContain("  files: no planned files on the go check");
      });
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

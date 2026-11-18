// OB-2097: the overnight decision log lives in ob. `ob overnight start|decide|summary|show|list [--check]`, decision
// items with doubt and undo, one run doc per project per night.
//
// The local half runs against a throwaway SQLite store through `runCli`. The API half sends the CLI's own requests
// through `createObApi` on a real Postgres store (the ob 325 harness: a local cluster, no network, no live
// database), and the SAME script must print the same lines with the same exit codes both ways.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_ROUTES } from "../../../apps/cli/src/api/contract.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { HELP } from "../../../apps/cli/src/cli.ts";
import { appendToSection, emptySummary, localToday, summaryProblems } from "../../../apps/cli/src/overnight.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const README = readFileSync(join(import.meta.dir, "../../../apps/cli/README.md"), "utf8");
const NIGHT = "2026-11-17";

type Run = (args: string[]) => Promise<{ code: number; out: string; err: string }>;

/** Timestamps vary between runs; everything else must match byte for byte. */
function stable(s: string): string {
  return s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<ts>");
}

/** The ticket's Proof list as one script; asserts as it goes and returns the normalised log for the two paths. */
async function script(run: Run): Promise<string[]> {
  const log: string[] = [];
  const step = async (args: string[]) => {
    const r = await run(args);
    log.push(`${args.join(" ")} => ${r.code}\n${stable(r.out)}${stable(r.err)}`);
    return r;
  };
  expect((await step(["project", "add", "alpha", "--kind", "side", "--key", "AL"])).code).toBe(0);

  // A night must be started before a decision joins it; the refusal names the command.
  const early = await step(["overnight", "decide", "Too early", "--what", "x", "--why", "y", "--project", "alpha", "--night", NIGHT]);
  expect(early.code).toBe(1);
  expect(early.err).toContain(`ob overnight start --project alpha --date ${NIGHT}`);

  // start is idempotent: the second call finds the same doc.
  const s1 = await step(["overnight", "start", "--project", "alpha", "--date", NIGHT]);
  expect(s1.code).toBe(0);
  expect(s1.out).toContain(`started: Overnight review: alpha, ${NIGHT} (AL-1)`);
  expect(s1.out).toContain(`--night ${NIGHT}`);
  const s2 = await step(["overnight", "start", "--project", "alpha", "--date", NIGHT]);
  expect(s2.out).toContain(`already started: Overnight review: alpha, ${NIGHT} (AL-1)`);
  expect((await step(["overnight", "start", "--project", "alpha", "--date", NIGHT, "-q"])).out.trim()).toBe(NIGHT);
  expect((await step(["doc", "show", "AL-1"])).out).toContain("## Shipped\n\n- none\n\n## Review these\n\n- none");

  // decide stores all six fields and the night's tag.
  const d1 = await step([
    "overnight", "decide", "Landed AL-9", "--what", "merged PR 3 after a green gate", "--why", "State landable",
    "--doubt", "medium: the loop never reproduced it", "--undo", "git revert abc123", "--context", "his ask: land it", "--project", "alpha", "--night", NIGHT,
  ]);
  expect(d1.code).toBe(0);
  expect(d1.out.trim()).toBe(`AL-2  Landed AL-9  (night ${NIGHT})`);
  const d2 = await step(["overnight", "decide", "Held PR 4", "--what", "held it", "--why", "needs his eyes", "--project", "alpha", "--night", NIGHT]);
  expect(d2.code).toBe(0);
  // A daytime decision: no --night, so no run and no tag.
  const day = await step(["overnight", "decide", "Daytime call", "--what", "x", "--why", "y", "--project", "alpha"]);
  expect(day.out.trim()).toBe("AL-4  Daytime call  (daytime)");

  const shown = await step(["show", "AL-2"]);
  expect(shown.out).toContain("doubt    : medium: the loop never reproduced it");
  expect(shown.out).toContain("undo     : git revert abc123");
  expect(shown.out).toContain("choice   : merged PR 3 after a green gate");
  expect(shown.out).toContain(`tags:      overnight:${NIGHT}`);
  const dec = await step(["decision", "AL-2"]);
  expect(dec.out).toContain("  doubt:      medium: the loop never reproduced it");
  expect(dec.out).toContain("  undo:       git revert abc123");
  expect(dec.out).toContain("  rationale:  State landable");
  expect(dec.out).toContain("  context:    his ask: land it");
  const asJson = JSON.parse((await run(["overnight", "show", "--project", "alpha", "--date", NIGHT, "--json"])).out);
  expect(asJson.decisions[0]).toMatchObject({
    title: "Landed AL-9",
    status: "accepted",
    night: NIGHT,
    what: "merged PR 3 after a green gate",
    why: "State landable",
    doubt: "medium: the loop never reproduced it",
    undo: "git revert abc123",
    context: "his ask: land it",
  });

  // summary appends, replacing `- none`, and refuses an unknown section.
  expect((await step(["overnight", "summary", "shipped", "--add", "AL-9 landed (PR 3)", "--project", "alpha", "--date", NIGHT])).code).toBe(0);
  expect((await step(["overnight", "summary", "shipped", "--add", "AL-8 landed (PR 2)", "--project", "alpha"])).code).toBe(0);
  expect((await step(["overnight", "summary", "review", "--add", "PR 4 held, decision 2", "--project", "alpha"])).code).toBe(0);
  const badSection = await step(["overnight", "summary", "wins", "--add", "x", "--project", "alpha"]);
  expect(badSection.code).toBe(2);
  expect(badSection.err).toContain("unknown summary section 'wins' (shipped, review, skipped, next)");
  expect((await step(["doc", "history", "AL-1"])).out.trim().split("\n")).toHaveLength(3);

  // show prints the night: the summary, then decisions in decided_at order with what, why, doubt, undo.
  const night = await step(["overnight", "show", "--project", "alpha"]);
  expect(night.code).toBe(0);
  const text = night.out;
  expect(text).toContain("## Shipped\n- AL-9 landed (PR 3)\n- AL-8 landed (PR 2)\n\n## Review these\n- PR 4 held, decision 2\n\n## Skipped / needs you\n- none");
  expect(text.indexOf("1. Landed AL-9")).toBeLessThan(text.indexOf("2. Held PR 4"));
  expect(text).toContain("   doubt:   medium: the loop never reproduced it");
  expect(text).toContain("   undo:    not recorded");
  expect(text).not.toContain("Daytime call");
  expect(text).not.toContain("problem:");

  // A note on a decision is its trail, and show prints it.
  expect((await step(["note", "AL-3", "merged after his yes"])).code).toBe(0);
  expect((await step(["overnight", "show", "--project", "alpha"])).out).toMatch(/notes:\n {5}\[[^\]]+\] merged after his yes/);

  // list counts each run; --check is clean.
  expect((await step(["overnight", "start", "--project", "alpha", "--date", "2026-11-18"])).code).toBe(0);
  const list = await step(["overnight", "list"]);
  expect(list.out.trim().split("\n")).toEqual([`${NIGHT}  alpha  2 decisions  1 to review`, "2026-11-18  alpha  0 decisions  0 to review"]);
  expect((await step(["overnight", "list", "--since", "2026-11-18"])).out.trim()).toBe("2026-11-18  alpha  0 decisions  0 to review");
  expect((await step(["overnight", "list", "--check"])).code).toBe(0);

  // A summary hand-edited with `ob doc set` to drop a heading: show reports it, list --check exits 1 naming the run.
  expect((await step(["doc", "set", "AL-5", "--body", "## Shipped\n\n- none\n\n## Review these\n\n- none\n\n## Next actions\n\n- none\n"])).code).toBe(0);
  const broken = await step(["overnight", "show", "--project", "alpha", "--date", "2026-11-18"]);
  expect(broken.out).toContain("problem: summary is missing '## Skipped / needs you'");
  const check = await step(["overnight", "list", "--check"]);
  expect(check.code).toBe(1);
  expect(check.err).toContain("overnight run alpha 2026-11-18 (AL-5): summary is missing '## Skipped / needs you'");
  const noSection = await step(["overnight", "summary", "skipped", "--add", "x", "--project", "alpha", "--date", "2026-11-18"]);
  expect(noSection.code).toBe(1);
  expect(noSection.err).toContain("has no '## Skipped / needs you'");

  // Usage errors: exit 2, the same words on both paths.
  const usage: Array<[string[], string]> = [
    [["overnight", "decide", "No what", "--why", "y", "--project", "alpha"], "overnight decide requires --what"],
    [["overnight", "decide", "No why", "--what", "x", "--project", "alpha"], "overnight decide requires --why"],
    [["overnight", "decide", "--what", "x", "--why", "y", "--project", "alpha"], 'overnight decide requires a "<title>"'],
    [["overnight", "decide", "Bad night", "--what", "x", "--why", "y", "--project", "alpha", "--night", "tonight"], "--night must be a date YYYY-MM-DD"],
    [["overnight", "start", "--project", "alpha", "--date", "2026-02-30"], "--date must be a date YYYY-MM-DD"],
    [["overnight", "summary", "shipped", "--project", "alpha"], "overnight summary requires --add '<line>'"],
    [["overnight", "show", "--project", "nope"], "project 'nope' does not exist"],
    [["overnight", "frob"], "unknown overnight subcommand 'frob' (start|decide|summary|show|list)"],
  ];
  for (const [args, message] of usage) {
    const r = await step(args);
    expect(r.code, args.join(" ")).toBe(2);
    expect(r.err).toContain(message);
  }
  const noRun = await step(["overnight", "show", "--project", "alpha", "--date", "2026-01-01"]);
  expect(noRun.code).toBe(1);
  expect(noRun.err).toContain("no overnight run for alpha on 2026-01-01");
  return log;
}

let localLog: string[] = [];

describe("ob overnight, local (OB-2097)", () => {
  test("the Proof script on a throwaway SQLite store", async () => {
    const dbPath = freshDbPath();
    localLog = await script((args) => runCli(dbPath, args));
  });
});

describe("ob overnight over the API (OB-2097)", () => {
  test("routed, declared, and documented", () => {
    const declared = OB_API_ROUTES.map((r) => `${r.method} ${r.path}`);
    for (const r of ["POST /overnight/start", "POST /overnight/decide", "POST /overnight/summary", "POST /overnight/show", "GET /overnight/runs"]) {
      expect(declared).toContain(r);
    }
    expect(API_ROUTED_COMMANDS.has("overnight")).toBe(true);
    expect(API_HANDLERS.overnight).toBeDefined();
    for (const doc of [HELP, README]) {
      for (const s of ["overnight start", "overnight decide", "overnight summary", "overnight show", "overnight list", "--doubt", "--undo", "--night", "--check", "--since"]) {
        expect(doc).toContain(s);
      }
    }
  });

  test("the same script through the server prints the same lines with the same exit codes", async () => {
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
      const apiLog = await script((args) => runCli(freshDbPath(), args, { api: { base: BASE, token: TOKEN, transport } }));
      expect(apiLog).toEqual(localLog);
    } finally {
      await store.close?.();
    }
  }, 60_000);
});

describe("the summary template", () => {
  test("a multi-line summary line keeps its later lines indented under the bullet", () => {
    const body = appendToSection(emptySummary(), "next", "last line\nwith a second line");
    expect(body.endsWith("## Next actions\n\n- last line\n  with a second line\n")).toBe(true);
    expect(summaryProblems(body)).toEqual([]);
  });
  test("summaryProblems names an extra, a repeated and an out-of-order heading", () => {
    expect(summaryProblems(emptySummary() + "\n## Wins\n\n- x\n")).toEqual(["summary has an extra heading '## Wins'"]);
    expect(summaryProblems(emptySummary() + "\n## Shipped\n\n- x\n")).toEqual(["summary has '## Shipped' 2 times"]);
    const swapped = "## Review these\n\n- none\n\n## Shipped\n\n- none\n\n## Skipped / needs you\n\n- none\n\n## Next actions\n\n- none\n";
    expect(summaryProblems(swapped)).toEqual(["summary headings are out of order (Shipped, Review these, Skipped / needs you, Next actions)"]);
  });
  test("localToday is the local calendar date", () => {
    expect(localToday(new Date(2026, 10, 17, 23, 59))).toBe("2026-11-17");
  });
});

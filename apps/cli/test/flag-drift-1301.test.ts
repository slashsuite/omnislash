import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLAGS, HELP } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { fakeRepoDir, freshDbPath, runCli } from "./helpers.ts";
import { syncAwait } from "./sync-await.ts";
import { enqueueSpinoff, listSpinoffs, stampArgv } from "../../../platform/cli-coord/src/commands/spinoff.ts";

// 1301 — `ob --help` advertised `--engine` for `spinoff stamp`; the parser rejected it.
//
// The two halves of an invocation are written in one file and were never checked against each other: HELP
// (the text a human reads and retypes from) and FLAGS (the table `parseArgs` resolves against). 131's file
// beside this one pins flags that were REMOVED; this one pins that the two halves AGREE, so a flag can no
// longer be documented into existence (or dropped out of the table) without a test failing.
//
// WHICH ANSWER 1301 TOOK: the flag is real and the TABLE was wrong. Everything downstream of the parser
// already implemented `--engine` — `apiSpinoff` read it, `stampSpinoff` persisted it, `stampArgv` built it
// into the split drain's own stamp invocation, and HELP and README both documented it. So a flag that
// carries a LAUNCH fact (the harness the launch resolved, which reconcile reads a row's token transcript
// from) had no way onto a row by hand, not even the recovery re-stamp the drain's partial-failure message
// tells a human to retype — and on a split host the drain's OWN stamp was rejected before it could write.

/**
 * Flags that appear inside a usage line but are not ob's. Listed by name with the reason, the same way
 * `docs-completeness.test.ts` handles the commands it deliberately skips — so a genuine new drift cannot
 * hide behind a pattern.
 */
const NOT_OB_FLAGS = new Map([
  ["user", "`daemon install`'s usage line says 'Linux systemd --user'; that is systemd's flag, not ob's"],
]);

/**
 * HELP's usage lines: two or three spaces, then a command word. The prose under them is indented much
 * further, so a `--flag` mentioned in an explanation (a foreign tool's, or one of ob's own discussed in
 * passing) is readable as prose rather than as an invocation a human will retype.
 */
function usageLines(text: string): string[] {
  return text.split("\n").filter((line) => /^ {2,3}[a-z][a-z0-9-]*(\s|$)/.test(line));
}

describe("the help text and the parser's flag table agree (1301)", () => {
  test("every flag a usage line names is in FLAGS", () => {
    const named = new Set<string>();
    for (const line of usageLines(HELP)) {
      for (const m of line.matchAll(/--([a-z0-9-]+)/g)) named.add(m[1]!);
    }
    // A sanity floor: the extraction found usage lines at all, so an empty result cannot pass as clean.
    expect(named.size).toBeGreaterThan(20);
    const missing = [...named].filter((f) => !(f in FLAGS) && !NOT_OB_FLAGS.has(f)).sort();
    expect(
      missing,
      missing.length
        ? `These flags are named in a \`ob --help\` usage line but are absent from FLAGS in apps/cli/src/cli.ts, so \`parseArgs\` rejects them: ${missing.join(", ")}. Add them to FLAGS, or stop naming them in HELP.`
        : "",
    ).toEqual([]);
  });

  test("`spinoff stamp --engine` is accepted, and the engine lands on the row", async () => {
    // The exact argv the SPLIT drain's stamp builds (191, `stampArgv`): on a client this crosses the wire
    // and is parsed by the server's `ob`, which is where `Unknown option '--engine'` used to reject it.
    expect(HELP).toContain("spinoff stamp --id <n> --outcome launched|failed");
    expect(HELP).toContain("--engine");

    const dbPath = freshDbPath();
    const worktree = mkdtempSync(join(tmpdir(), "ob-1301-wt-"));
    const db = openDb(dbPath);
    const { row } = syncAwait(
      enqueueSpinoff(db, {
        ticketRef: "1301",
        repo: fakeRepoDir(),
        branch: "1301-flag-drift",
        worktree,
        mode: "agent",
        brief: "b",
      }),
    );
    // OB-1920: the drain stamps a CLAIMED row; a launch stamp on a pending row is refused.
    db.query("UPDATE spinoff SET status = 'launching' WHERE id = ?").run(row.id);
    db.close();

    const argv = stampArgv({
      id: row.id,
      outcome: "launched",
      worktree,
      base_sha: null,
      launcher: "headless",
      engine: "opencode",
    });
    expect(argv).toContain("--engine");
    const res = await runCli(dbPath, argv);
    expect(res.err).toBe("");
    expect(res.code).toBe(0);

    const after = openDb(dbPath);
    const rows = syncAwait(listSpinoffs(after, "launched"));
    after.close();
    rmSync(worktree, { recursive: true, force: true });
    // The ENGINE is the point: a stamp that parsed the flag and dropped it would still exit 0.
    expect(rows.map((r) => [r.engine, r.launcher])).toEqual([["opencode", "headless"]]);
  });
});

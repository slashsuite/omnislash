import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_HELP, FLAGS, GLOBAL_FLAGS, renderSubcommandHelp } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { fakeRepoDir, freshDbPath, runCli } from "./helpers.ts";
import { syncAwait } from "./sync-await.ts";
import { enqueueSpinoff, listSpinoffs, stampArgv } from "../../../platform/cli-coord/src/commands/spinoff.ts";

// 1301 — `ob --help` advertised `--engine` for `spinoff stamp`; the parser rejected it.
//
// The two halves of an invocation must agree: the structured COMMAND_HELP / GLOBAL_FLAGS registry
// (the text a human reads and retypes from) and FLAGS (the table `parseArgs` resolves against).
// This test walks every command and subcommand entry so a flag can no longer be documented into
// existence (or dropped out of the table) without a test failing.

/**
 * Flags that appear inside a usage or flag spec but are not ob's. Listed by name with the reason
 * so a genuine new drift cannot hide behind a pattern.
 */
const NOT_OB_FLAGS = new Map<string, string>([]);

function collectDocumentedFlags(): Set<string> {
  const named = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/--([a-z0-9-]+)/g)) named.add(m[1]!);
  };

  for (const f of GLOBAL_FLAGS) scan(f.flag);

  for (const meta of Object.values(COMMAND_HELP)) {
    for (const u of meta.usage) scan(u);
    for (const f of meta.flags ?? []) scan(f.flag);
    if (meta.subcommands) {
      for (const sub of Object.values(meta.subcommands)) {
        for (const u of sub.usage) scan(u);
        for (const f of sub.flags ?? []) scan(f.flag);
      }
    }
  }
  return named;
}

describe("the help text and the parser's flag table agree (1301)", () => {
  test("every flag in COMMAND_HELP and GLOBAL_FLAGS is in FLAGS", () => {
    const named = collectDocumentedFlags();
    // A sanity floor: extraction found documented flags, so an empty result cannot pass as clean.
    expect(named.size).toBeGreaterThan(20);
    const missing = [...named].filter((f) => !(f in FLAGS) && !NOT_OB_FLAGS.has(f)).sort();
    expect(
      missing,
      missing.length
        ? `These flags are named in COMMAND_HELP/GLOBAL_FLAGS but are absent from FLAGS in apps/cli/src/cli.ts, so \`parseArgs\` rejects them: ${missing.join(", ")}. Add them to FLAGS, or stop naming them in apps/cli/src/help.ts.`
        : "",
    ).toEqual([]);
  });

  test("`spinoff stamp --engine` is accepted, and the engine lands on the row", async () => {
    // The exact argv the SPLIT drain's stamp builds (191, `stampArgv`): on a client this crosses the wire
    // and is parsed by the server's `ob`, which is where `Unknown option '--engine'` used to reject it.
    const stampHelp = renderSubcommandHelp("spinoff", "stamp");
    expect(stampHelp).toContain("spinoff stamp --id <n> --outcome launched|failed");
    expect(stampHelp).toContain("--engine");

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

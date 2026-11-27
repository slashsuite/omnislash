// OS-285: pr-wait is the PR-opened hook for spinoff.phase. A builder runs it right after `gh pr create` and after
// every later push, so on start it moves the building row whose branch is the PR head to pr_ci. Driven end to end
// against a fake `gh` and a fake `ob` on PATH: no network, no GitHub, no tracker.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PR_WAIT = resolve(import.meta.dir, "../../../skills/ob-babysit-pr/scripts/pr-wait");
const HEAD = "d".repeat(40);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Row = { id: number; ticket_ref: string; repo: string; branch: string; status: string; phase?: string | null };

/** A fake gh (one open PR on o/r branch os-9, its gate green) and a fake ob that logs every call and lists `rows`. */
function fakes(rows: Row[], phaseExit = 0): { dir: string; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "os-285-prwait-"));
  dirs.push(dir);
  const checks = join(dir, "checks.json");
  writeFileSync(checks, JSON.stringify([{ name: "gate", bucket: "pass", link: "https://github.com/o/r/actions/runs/1" }]));
  const pr = JSON.stringify({ state: "OPEN", headRefOid: HEAD, headRefName: "os-9", mergeStateStatus: "CLEAN", author: { login: "builder" }, url: "https://github.com/o/r/pull/7" });
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/usr/bin/env bash",
      'case "$1 $2" in',
      '  "api user") echo me ;;',
      '  "api "*) ;;',
      `  "pr checks") cat '${checks}' ;;`,
      `  "pr view") if [[ "$*" == *"--json number"* ]]; then echo '{"number":7}'; else echo '${pr}'; fi ;;`,
      '  *) echo "unexpected gh $*" >&2; exit 3 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  const log = join(dir, "ob.log");
  const list = JSON.stringify(rows);
  writeFileSync(
    join(dir, "ob"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> '${log}'`,
      'echo "ob: core from omnislash@0000000" >&2',
      'case "$1 $2" in',
      `  "spinoff list") echo '${list}' ;;`,
      `  "spinoff phase") ${phaseExit === 0 ? "echo pr_ci" : `echo "error: spinoff #${rows[0]?.id} is landed: it cannot be in phase 'pr_ci'" >&2; exit ${phaseExit}`} ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "gh"), 0o755);
  chmodSync(join(dir, "ob"), 0o755);
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")) : []) };
}

async function prWait(dir: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["python3", PR_WAIT, "7", "--repo", "o/r", "--until", "green", "--interval", "5"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, PR_WAIT_OB: join(dir, "ob") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
}

const LIST = ["spinoff", "list", "--status", "building", "--json"];
const row = (over: Partial<Row> = {}): Row => ({ id: 41, ticket_ref: "OS-9", repo: "r", branch: "os-9", status: "building", phase: null, ...over });

describe("pr-wait marks a building row pr_ci (OS-285)", () => {
  test("an open PR on a building row's branch and repo moves that row to pr_ci, then watches as before", async () => {
    // a trial's leg b (same ticket, newer, branch os-9-b) does not hide leg a's row
    const f = fakes([row({ id: 42, branch: "os-9-b" }), row()]);
    const r = await prWait(f.dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("#7 green on ddddddd");
    expect(f.calls()).toEqual([LIST, ["spinoff", "phase", "41", "pr_ci", "-q"]]);
    expect(r.err).toContain("pr-wait: OS-9 is in phase pr_ci");
  });

  test("a handed-off row, a sent-back row in updating_pr, a same-branch row in another repo, or no row: left alone", async () => {
    for (const rows of [[row({ status: "handed-off" })], [row({ phase: "updating_pr" })], [row({ repo: "other" })], []]) {
      const f = fakes(rows);
      expect((await prWait(f.dir)).code, JSON.stringify(rows)).toBe(0);
      expect(f.calls(), JSON.stringify(rows)).toEqual([LIST]);
    }
  });

  test("a refused phase is one stderr line and the watch still runs to green", async () => {
    const f = fakes([row()], 1);
    const r = await prWait(f.dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("#7 green on ddddddd");
    expect(r.err).toContain("pr-wait: could not mark OS-9 pr_ci (error: spinoff #41 is landed: it cannot be in phase 'pr_ci'); watching anyway");
  });
});

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

type Row = { id: number; ticket_ref: string; branch: string; status: string };

/** A fake gh (one open PR on branch os-9, its gate green) and a fake ob that logs every call and answers from `row`. */
function fakes(row: Row | null, phaseExit = 0): { dir: string; calls: () => string[][] } {
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
  const show = row ? JSON.stringify(row) : "";
  writeFileSync(
    join(dir, "ob"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> '${log}'`,
      'echo "ob: core from omnislash@0000000" >&2',
      'case "$1 $2" in',
      row ? `  "spinoff show") echo '${show}' ;;` : '  "spinoff show") echo "error: no spinoff matching" >&2; exit 1 ;;',
      `  "spinoff phase") ${phaseExit === 0 ? "echo pr_ci" : `echo "error: spinoff #${row?.id} is landed: it cannot be in phase 'pr_ci'" >&2; exit ${phaseExit}`} ;;`,
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

describe("pr-wait marks a building row pr_ci (OS-285)", () => {
  test("an open PR on a building row's branch moves that row to pr_ci, then watches as before", async () => {
    const f = fakes({ id: 41, ticket_ref: "OS-9", branch: "os-9", status: "building" });
    const r = await prWait(f.dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("#7 green on ddddddd");
    expect(f.calls()).toEqual([
      ["spinoff", "show", "os-9", "--json"],
      ["spinoff", "phase", "41", "pr_ci", "-q"],
    ]);
    expect(r.err).toContain("pr-wait: OS-9 is in phase pr_ci");
  });

  test("a handed-off row (the architect watching it) is left alone", async () => {
    const f = fakes({ id: 41, ticket_ref: "OS-9", branch: "os-9", status: "handed-off" });
    const r = await prWait(f.dir);
    expect(r.code).toBe(0);
    expect(f.calls()).toEqual([["spinoff", "show", "os-9", "--json"]]);
  });

  test("a row matched by ticket on another branch, or no row at all, is left alone", async () => {
    const other = fakes({ id: 41, ticket_ref: "OS-9", branch: "os-9-old", status: "building" });
    expect((await prWait(other.dir)).code).toBe(0);
    expect(other.calls()).toEqual([["spinoff", "show", "os-9", "--json"]]);
    const none = fakes(null);
    expect((await prWait(none.dir)).code).toBe(0);
    expect(none.calls()).toEqual([["spinoff", "show", "os-9", "--json"]]);
  });

  test("a refused phase is one stderr line and the watch still runs to green", async () => {
    const f = fakes({ id: 41, ticket_ref: "OS-9", branch: "os-9", status: "building" }, 1);
    const r = await prWait(f.dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("#7 green on ddddddd");
    expect(r.err).toContain("pr-wait: could not mark OS-9 pr_ci (error: spinoff #41 is landed: it cannot be in phase 'pr_ci'); watching anyway");
  });
});

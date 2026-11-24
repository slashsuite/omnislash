// OB-2544: `pr-wait` (skills/ob-babysit-pr/scripts/pr-wait) treats a pending PixelSlash status as a human
// review owed, not CI still running. Driven end to end against a fake `gh` on PATH: no network, no GitHub.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PR_WAIT = resolve(import.meta.dir, "../../../skills/ob-babysit-pr/scripts/pr-wait");
const HEAD = "c".repeat(40);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Check = { name: string; bucket: string; link: string; description?: string };

/** A fake `gh` that answers the calls pr-wait makes, from a fixture of the PR head's checks. */
function fakeGh(checks: Check[]): { path: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "ob-2544-prwait-"));
  dirs.push(dir);
  const fixture = join(dir, "checks.json");
  writeFileSync(fixture, JSON.stringify(checks));
  const pr = JSON.stringify({ state: "OPEN", headRefOid: HEAD, mergeStateStatus: "CLEAN", author: { login: "builder" }, url: "https://github.com/o/r/pull/7" });
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/usr/bin/env bash",
      'case "$1 $2" in',
      '  "api user") echo me ;;',
      '  "api "*) ;;',
      `  "pr checks") cat '${fixture}'; exit 8 ;;`,
      '  "pr view") if [[ "$*" == *"--json number"* ]]; then echo \'{"number":7}\'; else echo \'' + pr + "'; fi ;;",
      '  *) echo "unexpected gh $*" >&2; exit 3 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "gh"), 0o755);
  return { path: dir, home: dir };
}

async function prWait(checks: Check[], until = "green", killAfterMs = 15_000): Promise<{ code: number; out: string }> {
  const gh = fakeGh(checks);
  const proc = Bun.spawn(["python3", PR_WAIT, "7", "--repo", "o/r", "--until", until, "--interval", "5"], {
    env: { ...process.env, PATH: `${gh.path}:${process.env.PATH}`, HOME: gh.home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), killAfterMs);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: await new Response(proc.stdout).text() };
}

const pixel = (bucket: string, name = "PixelSlash / hackcove-ui-actions"): Check => ({
  name,
  bucket,
  link: "http://pixelslash.lan/builds/1",
  description: "7 changes to review",
});
const gate: Check = { name: "gate", bucket: "pass", link: "https://github.com/o/r/actions/runs/1" };

describe("pr-wait: a PixelSlash review is not CI (OB-2544)", () => {
  test("green CI with a pending PixelSlash status exits 0 and names the owed review", async () => {
    const r = await prWait([gate, { name: "ui-review", bucket: "pass", link: "u" }, pixel("pending"), pixel("pending", "PixelSlash")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("#7 PixelSlash review owed: PixelSlash / hackcove-ui-actions (7 changes to review) http://pixelslash.lan/builds/1");
    expect(r.out).toContain("#7 PixelSlash review owed: PixelSlash (7 changes to review)");
    expect(r.out).toContain("#7 green on ccccccc");
  });

  test("--until ready also goes through a pending PixelSlash review", async () => {
    const r = await prWait([gate, pixel("pending")], "ready");
    expect(r.code).toBe(0);
    expect(r.out).toContain("PixelSlash review owed:");
    expect(r.out).toContain("ready on ccccccc");
  });

  test("a failed PixelSlash status still exits 1: a broken upload, not a review", async () => {
    const r = await prWait([gate, pixel("fail")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("PixelSlash failed (a broken upload, not a review) on ccccccc: http://pixelslash.lan/builds/1");
  });

  test("a failing non-PixelSlash check exits 1, naming it", async () => {
    const r = await prWait([gate, { name: "ui-review", bucket: "fail", link: "https://x/2" }]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("check ui-review failed on ccccccc: https://x/2");
  });

  test("a non-PixelSlash check still running is waited on: no green", async () => {
    const r = await prWait([gate, { name: "ui-review", bucket: "pending", link: "u" }, pixel("pending")], "green", 3_000);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("green on");
  });

  test("a repo whose CI is not named gate goes green once its checks pass; PixelSlash alone never does", async () => {
    const ci: Check = { name: "build", bucket: "pass", link: "https://x/4" };
    const r = await prWait([ci, pixel("pending")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PixelSlash review owed:");
    expect(r.out).toContain("#7 green on ccccccc");
    const alone = await prWait([pixel("pending")], "green", 3_000);
    expect(alone.code).not.toBe(0);
    expect(alone.out).not.toContain("green on");
  });

  test("two checks of the same name both count: a failed one is not hidden by a passing twin", async () => {
    const r = await prWait([gate, { name: "test", bucket: "fail", link: "https://x/5" }, { name: "test", bucket: "pass", link: "https://x/6" }]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("check test failed on ccccccc: https://x/5");
  });

  test("a check named like PixelSlash but not it (PixelSlashed) is waited on as CI", async () => {
    const r = await prWait([gate, { name: "PixelSlashed", bucket: "fail", link: "https://x/3" }]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("check PixelSlashed failed");
  });
});

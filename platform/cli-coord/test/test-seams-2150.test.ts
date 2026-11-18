/**
 * OB-2150: a stub a test file leaves installed fails that file, not the next one.
 *
 * bun runs a project's test files in one process, so a module seam left stubbed reaches every later file
 * (OB-2145: a lost `__setSh` restore in t3-dispatch.test.ts failed 9 tests in spinoff.test.ts). The preload's
 * `afterEach` guard (`apps/cli/test/preload.ts`) resets a leaked seam and fails the test that leaked it. These
 * tests run a child `bun test` on two fixture files, a leaker and then a file that needs the real seam, and
 * read its output.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seamNames } from "../../../apps/cli/src/test-seams.ts";

const REPO = resolve(import.meta.dir, "../../..");
const PRELOAD = join(REPO, "apps/cli/test/preload.ts");
const SPINOFF = join(REPO, "platform/cli-coord/src/commands/spinoff.ts");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const REAL_FILE = `
import { expect, test } from "bun:test";
import { __shIsReal } from ${JSON.stringify(SPINOFF)};
test("needs the real shell runner", () => {
  expect(__shIsReal()).toBe(true);
});
`;

/** Run `bun test` with the suite's preload on a leaker file then REAL_FILE; the combined output and exit code. */
function runPair(leakerBody: string): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), "ob-2150-"));
  dirs.push(dir);
  const leaker = join(dir, "1-leak.test.ts");
  const real = join(dir, "2-real.test.ts");
  writeFileSync(leaker, leakerBody);
  writeFileSync(real, REAL_FILE);
  const p = Bun.spawnSync([process.execPath, "test", "--preload", PRELOAD, leaker, real], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  return { out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr), code: p.exitCode ?? -1 };
}

/** The `(fail) <name>` line bun prints for a failed test (the guard's failure names the test this way). bun prints no line for a pass when its output is not a terminal. */
function failed(out: string, name: string): boolean {
  return out.split("\n").some((l) => l.trim().startsWith("(fail)") && l.includes(name));
}

test("a stub never restored fails the test that left it, naming the seam, and the next file runs real", () => {
  const { out, code } = runPair(`
import { expect, test } from "bun:test";
import { __setSh } from ${JSON.stringify(SPINOFF)};
test("leaks a fake git", () => {
  __setSh(() => ({ ok: true, err: "", out: "" }));
  expect(1).toBe(1);
});
`);
  expect(code).not.toBe(0);
  expect(out).toContain("this test left the cli-coord/spinoff.sh seam stubbed (OB-2150)");
  expect(failed(out, "leaks a fake git")).toBe(true);
  expect(failed(out, "needs the real shell runner")).toBe(false);
  expect(out).toMatch(/1 pass\s+1 fail/);
});

test("a lost restore (two sets, the first restore overwritten) is caught the same way", () => {
  const { out, code } = runPair(`
import { afterEach, expect, test } from "bun:test";
import { __setSh } from ${JSON.stringify(SPINOFF)};
let restore = () => {};
afterEach(() => restore());
test("overwrites its first restore", () => {
  restore = __setSh(() => ({ ok: true, err: "", out: "a" }));
  restore = __setSh(() => ({ ok: true, err: "", out: "b" }));
  expect(1).toBe(1);
});
`);
  expect(code).not.toBe(0);
  expect(out).toContain("this test left the cli-coord/spinoff.sh seam stubbed (OB-2150)");
  expect(failed(out, "overwrites its first restore")).toBe(true);
  expect(failed(out, "needs the real shell runner")).toBe(false);
  expect(out).toMatch(/1 pass\s+1 fail/);
});

test("a stub restored in the file's own afterEach passes (the guard runs after it)", () => {
  const { out, code } = runPair(`
import { afterEach, expect, test } from "bun:test";
import { __setSh } from ${JSON.stringify(SPINOFF)};
let restore = () => {};
afterEach(() => restore());
test("restores its stub", () => {
  restore = __setSh(() => ({ ok: true, err: "", out: "" }));
  expect(1).toBe(1);
});
`);
  expect(out).not.toContain("OB-2150");
  expect(code).toBe(0);
  expect(out).toMatch(/2 pass\s+0 fail/);
});

test("every exported test seam is defined with defineSeam", async () => {
  await import("../src/commands/spinoff.ts");
  await import("../../../apps/cli/src/tracker-link.ts");
  await import("../../../apps/cli/src/github-issues.ts");
  await import("../../../apps/cli/src/t3/dispatch.ts");
  await import("../../../apps/cli/src/t3/read.ts");
  await import("../../../apps/cli/src/commands/models.ts");
  expect(seamNames()).toEqual(
    expect.arrayContaining([
      "cli-coord/spinoff.sh",
      "cli-coord/spinoff.mergedPrRead",
      "tracker-link.sh",
      "tracker-link.listIssues",
      "github-issues.githubGql",
      "github-issues.createIssue",
      "github-issues.fetchIssue",
      "github-issues.setIssueState",
      "t3/dispatch.t3Seam",
      "t3/read.rowSource",
      "commands/models.tierSettingReader",
    ]),
  );
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepNxTmp } from "./nx-tmp-sweep.ts";

// 1373: a killed Nx daemon leaks ~72MB of nx@latest into /tmp/tmp-<pid>-*/ until /tmp fills. OmniSlash runs
// moon now (OB-2033), but the other repos on this machine still run Nx, so the sweep stays.
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fixture(name: string, pkg: object, ageMs: number): string {
  const root = roots.at(-1)!;
  const dir = join(root, name);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  const t = new Date(Date.now() - ageMs);
  utimesSync(dir, t, t);
  return dir;
}

describe("nx daemon tmp leak (1373)", () => {
  test("sweep removes only old, dead-pid nx probe dirs", () => {
    roots.push(mkdtempSync(join(tmpdir(), "nx-sweep-")));
    const probe = { devDependencies: { nx: "^24.0.1" } };
    const OLD = 2 * 60 * 60 * 1000;
    const dead = fixture("tmp-111-AbCdEf123456", probe, OLD);
    const live = fixture("tmp-222-AbCdEf123456", probe, OLD);
    const fresh = fixture("tmp-333-AbCdEf123456", probe, 1000);
    const foreign = fixture("tmp-444-AbCdEf123456", { dependencies: { left: "1" } }, OLD);
    const other = fixture("not-a-tmp-dir", probe, OLD);
    const lookalike = fixture("tmp-555-AbCdEf123456", probe, OLD);
    writeFileSync(join(lookalike, "precious.txt"), "someone else's data");

    const removed = sweepNxTmp(roots.at(-1)!, { alive: (pid) => pid === 222 });

    expect(removed).toEqual([dead]);
    expect(existsSync(dead)).toBe(false);
    for (const kept of [live, fresh, foreign, other, lookalike]) expect(existsSync(kept)).toBe(true);
  });

  test("a missing root is not an error", () => {
    expect(sweepNxTmp(join(tmpdir(), "nx-sweep-no-such-dir"))).toEqual([]);
  });
});

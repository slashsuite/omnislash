import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRootOf, splitOwnRows } from "../../../apps/cli/src/t3/dispatch.ts";

// OB-1670 (#80): a builder could run `ob close` from its own worktree (since OB-1686 / #82 the architect closes; the skip stays). The close's T3
// side must leave that builder's own thread alone (no land reply, no settle) while still acting on every
// other row, exactly as an architect's close from `main` always has.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "ob-1670-"));
  dirs.push(d);
  return d;
}

describe("checkoutRootOf (OB-1670)", () => {
  test("finds a linked worktree's root from a subdirectory (.git is a FILE there)", () => {
    const root = scratch();
    const wt = join(root, "acme.ob-1670");
    mkdirSync(join(wt, "apps", "cli"), { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
    expect(checkoutRootOf(join(wt, "apps", "cli"))).toBe(checkoutRootOf(wt));
    expect(checkoutRootOf(wt)).toContain("acme.ob-1670");
  });

  test("is null outside any checkout", () => {
    expect(checkoutRootOf(scratch())).toBeNull();
  });
});

describe("splitOwnRows (OB-1670)", () => {
  const rows = (wt: string, other: string) => [
    { id: 1092, worktree: wt },
    { id: 7, worktree: other },
  ];

  test("the row whose worktree is the closing checkout is the builder's own; the rest are acted on", () => {
    const root = scratch();
    const wt = join(root, "acme.ob-1670");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
    const { own, others } = splitOwnRows(rows(wt, join(root, "acme.ob-7")), checkoutRootOf(wt));
    expect(own.map((r) => r.id)).toEqual([1092]);
    expect(others.map((r) => r.id)).toEqual([7]);
  });

  test("a symlinked spelling of the same worktree still matches", () => {
    const root = scratch();
    const wt = join(root, "acme.ob-1670");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
    symlinkSync(wt, join(root, "link"));
    const { own } = splitOwnRows(rows(join(root, "link"), join(root, "x")), checkoutRootOf(wt));
    expect(own.map((r) => r.id)).toEqual([1092]);
  });

  test("an architect closing from main (or outside a checkout) holds nothing back", () => {
    const root = scratch();
    expect(splitOwnRows(rows(join(root, "a"), join(root, "b")), null).others).toHaveLength(2);
    expect(splitOwnRows(rows(join(root, "a"), join(root, "b")), join(root, "acme")).own).toEqual([]);
  });

  test("a failed (abandoned) row is neither told nor settled (OB-1685)", () => {
    const root = scratch();
    const split = splitOwnRows(
      [
        { id: 1, worktree: join(root, "a"), status: "failed" },
        { id: 2, worktree: join(root, "b"), status: "launched" },
      ],
      null,
    );
    expect(split.retired.map((r) => r.id)).toEqual([1]);
    expect(split.others.map((r) => r.id)).toEqual([2]);
  });
});

import { describe, expect, test } from "bun:test";
import { freshDbPath, runCli } from "./helpers.ts";

// 131 — CLI flag drift resolution.
//   list  --mine : removed (single-user tracker; the flag was inert).
//   audit --kind : gone with `ob audit` itself (1121).

describe("list --mine is removed (131)", () => {
  test("--mine is rejected as an unknown flag", async () => {
    const db = freshDbPath();
    const r = await runCli(db, ["list", "--mine"]);
    expect(r.code).toBe(2);
    expect(r.err.toLowerCase()).toContain("mine");
  });

  test("plain list still works", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "proj", "--kind", "side"]);
    await runCli(db, ["add", "a task", "--project", "proj", "-q"]);
    const r = await runCli(db, ["list", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).length).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { rivalRefNote } from "../../../apps/cli/src/commands/issue.ts";

// OB-1700: a bare number is the internal item id, but the ticket a builder sees is `OB-<n>`, a different
// item once the two sequences drifted (id 1697 is OB-1477; OB-1697 is id 2302). `ob issue landed 1697`
// then answered for the wrong item with nothing to say so. Pure functions only: no DB, no git, no network.

describe("rivalRefNote (OB-1700)", () => {
  test("a bare number whose OB-<n> is another item earns a note naming both", () => {
    const note = rivalRefNote("1697", "2302");
    expect(note).toContain("internal item id");
    expect(note).toContain("OB-1697");
    expect(note).toContain("2302");
    expect(note).toContain("ob issue landed OB-1697");
  });

  test("no note when OB-<n> is the same item, absent, or the argument is not a bare number", () => {
    expect(rivalRefNote("12", "12")).toBeNull();
    expect(rivalRefNote("12", null)).toBeNull();
    expect(rivalRefNote("OB-12", "2302")).toBeNull();
    expect(rivalRefNote("#12", "2302")).toBeNull();
  });
});

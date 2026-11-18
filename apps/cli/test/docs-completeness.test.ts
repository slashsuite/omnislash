import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDLERS, HELP } from "../src/cli.ts";

// 136 — docs-completeness backstop.
// Enforces the house rule "CLI changes ship with their docs": every top-level
// command registered in HANDLERS (apps/cli/src/cli.ts) MUST appear in BOTH the
// `ob --help` text (HELP, same file) AND the user guide (apps/cli/README.md).
// A new command with no docs fails this test instead of silently drifting.
//
// Matching is a whole-word check (so `add` does not match `address`). Only the
// top-level command token is required — subcommands (e.g. `whatsapp sync`) are
// covered transitively by their parent and are not individually asserted here.
//
// Intentional omissions can be listed in IGNORE with a comment explaining why.
const IGNORE = new Set<string>([
  // (none) — every current command is documented.
]);

const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

function documentedIn(haystack: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

describe("CLI docs completeness (136)", () => {
  const commands = Object.keys(HANDLERS).filter((c) => !IGNORE.has(c));

  test("every HANDLERS command is documented in the HELP text", () => {
    const missing = commands.filter((c) => !documentedIn(HELP, c));
    expect(
      missing,
      missing.length
        ? `These HANDLERS commands are missing from the \`ob --help\` HELP string in apps/cli/src/cli.ts: ${missing.join(", ")}. Add them to HELP (or, if intentionally undocumented, to IGNORE in this test with a comment).`
        : "",
    ).toEqual([]);
  });

  test("every HANDLERS command is documented in README.md", () => {
    const missing = commands.filter((c) => !documentedIn(README, c));
    expect(
      missing,
      missing.length
        ? `These HANDLERS commands are missing from apps/cli/README.md: ${missing.join(", ")}. Document them there (or, if intentionally undocumented, add to IGNORE in this test with a comment).`
        : "",
    ).toEqual([]);
  });
});

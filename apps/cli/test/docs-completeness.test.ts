import { describe, expect, test } from "bun:test";
import { HANDLERS } from "../src/cli.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 136 — docs-completeness backstop.
// Enforces the house rule "CLI changes ship with their docs": every top-level
// command registered in HANDLERS (apps/cli/src/cli.ts) MUST appear in the user
// command reference (apps/cli/docs/commands.md); a changelog mention does not count. Completeness against COMMAND_HELP and root help is
// enforced by apps/cli/test/help-system.test.ts.
//
// Matching is a whole-word check (so `add` does not match `address`). Only the
// top-level command token is required — subcommands (e.g. `whatsapp sync`) are
// covered transitively by their parent and are not individually asserted here.
//
// Intentional omissions can be listed in IGNORE with a comment explaining why.
const IGNORE = new Set<string>([
  // (none) — every current command is documented.
]);

const README = readFileSync(join(import.meta.dir, "..", "docs", "commands.md"), "utf8");

function documentedIn(haystack: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

describe("CLI docs completeness (136)", () => {
  const commands = Object.keys(HANDLERS).filter((c) => !IGNORE.has(c));

  test("every HANDLERS command is documented in the CLI docs", () => {
    const missing = commands.filter((c) => !documentedIn(README, c));
    expect(
      missing,
      missing.length
        ? `These HANDLERS commands are missing from the CLI docs (apps/cli/docs/commands.md): ${missing.join(", ")}. Document them there (or, if intentionally undocumented, add to IGNORE in this test with a comment).`
        : "",
    ).toEqual([]);
  });
});

// OS-217: the CLI docs are split across README.md, docs/guide.md, docs/commands.md and CHANGELOG.md. Tests
// that check a command or behaviour is documented read them as one text, so a passage can move between the
// files without breaking a test.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..");

export const CLI_DOC_FILES = ["README.md", "docs/guide.md", "docs/commands.md", "CHANGELOG.md"] as const;

/** Every CLI doc file, concatenated. */
export function cliDocs(): string {
  return CLI_DOC_FILES.map((f) => readFileSync(join(CLI, f), "utf8")).join("\n");
}

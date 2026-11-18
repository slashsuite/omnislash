import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { HELP, HANDLERS } from "../../../apps/cli/src/cli.ts";

const ROOT = join(import.meta.dir, "../../..");

describe("444: lander retired", () => {
  test("ob lander is an unknown command", async () => {
    const r = await runCli(freshDbPath(), ["lander", "--once"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command 'lander'");
    expect(HANDLERS.lander).toBeUndefined();
  });

  test("HELP and README have no lander command entry", () => {
    expect(HELP).not.toMatch(/^\s*lander\b/m);
    const readme = readFileSync(join(ROOT, "apps/cli/README.md"), "utf8");
    expect(readme).not.toMatch(/^\| `lander /m);
  });

});

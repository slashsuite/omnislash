// OS-303: a local models.jsonc `review` leg the profile has no reader for is dropped, and ob says so on stderr
// (one line per dropped leg) instead of dropping it without a word. The help example runs on the default readers.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelsFile } from "../../../apps/cli/src/models-file.ts";
import { droppedReaderWarnings, emptyRouteInputs, resolveReview } from "../../../apps/cli/src/model-routes.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");

const FILE = JSON.stringify({ active: "p", profiles: { p: { review: { opus: "claudeAgent:claude-opus-5-5", neon: "antigravity:gemini-4-neon" } } } });

function cli(dir: string) {
  const modelsFile = join(dir, "cfg", "models.jsonc");
  mkdirSync(join(dir, "cfg"), { recursive: true });
  writeFileSync(modelsFile, FILE);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OMNISLASH_STORE: "sqlite",
    OMNISLASH_DB_CREATE: "1",
    OMNISLASH_DB: join(dir, "ob.sqlite"),
    OB_REMOTE: "0",
    OMNISLASH_API: "",
    OMNISLASH_API_URL_FILE: join(dir, "no-api-url"),
    OB_MODELS_FILE: modelsFile,
  };
  return {
    modelsFile,
    run: (args: string[]) => {
      const r = Bun.spawnSync(["bun", CLI_ENTRY, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    },
  };
}

describe("OS-303: a dropped local review reader", () => {
  test("resolveReview lays the kept leg over the default reader, drops the other, and warns of nothing when nothing drops", () => {
    const r = resolveReview(emptyRouteInputs({ file: parseModelsFile(FILE, "/x/models.jsonc") }));
    expect(r.value.readers).toEqual({ opus: { model: "claudeAgent:claude-opus-5-5" } });
    expect(r.dropped).toEqual(["neon"]);
    expect(droppedReaderWarnings(resolveReview(emptyRouteInputs()), null)).toEqual([]);
  });

  test("ob review readers prints one stderr warning for it; the help's range example runs on the default readers", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-os303-"));
    try {
      const { run, modelsFile } = cli(dir);
      const r = run(["review", "readers", "--complexity", "5", "-q"]);
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe("opus");
      const warned = r.err.split("\n").filter((l) => l.includes("review.neon"));
      expect(warned).toEqual([`${modelsFile}: review.neon is ignored: profile 'p' has no 'neon' reader (its readers: opus); add it with 'ob review readers set neon --model <id>'`]);

      // help.ts's example `review readers range 4-6 opus` is accepted on a store with no readers set.
      const range = run(["review", "readers", "range", "4-6", "opus"]);
      expect(range.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

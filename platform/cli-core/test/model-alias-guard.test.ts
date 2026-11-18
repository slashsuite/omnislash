import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// 57: the installed `claude` CLI does not reliably resolve the full model id
// "claude-sonnet-5" for --model and silently falls back to the account default
// (Opus). The CLI's own --help documents aliases, and "sonnet" resolves to the
// latest Sonnet. Every hardcoded model-selection string in apps/cli/src must use
// the alias "sonnet", never the full id. This is a hermetic regression guard:
// it fails if the literal "claude-sonnet-5" reappears anywhere under
// apps/cli/src, and pins the three known model consts to "sonnet".

const SRC_ROOT = join(import.meta.dir, "../../../apps/cli/src");
const BANNED = "claude-sonnet-5";
// 1480: the ONE exemption. `t3/dispatch.ts` names T3 CATALOG ids (the spinoff tier → model defaults), not
// a `claude --model` argument: T3's catalog lists full ids (the acme project default is one), and ob
// refuses a model the catalog does not list rather than letting anything fall back. The `claude` CLI
// alias rule this guard enforces does not apply to that surface.
// OB-1969: the second. `models-file.ts` holds the skeptical-review legs' built-in model table, the one
// `skills/ob-skeptical-review/review-leg.ts` already ran with the full id before the table moved here; the
// models file names full ids by design (`<provider>:<model>`), so the alias rule does not apply to it.
const EXEMPT = new Set(["t3/dispatch.ts", "models-file.ts"]);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFiles(full));
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe("model-selection strings use the `sonnet` alias, not a full model id (57)", () => {
  test("no non-test source file under apps/cli/src contains the literal claude-sonnet-5", () => {
    const offenders = listFiles(SRC_ROOT)
      .filter((f) => readFileSync(f, "utf8").includes(BANNED))
      .map((f) => f.slice(SRC_ROOT.length + 1))
      .filter((f) => !EXEMPT.has(f));
    expect(
      offenders,
      offenders.length
        ? `These files under apps/cli/src still contain the literal "${BANNED}"; switch model selection to the "sonnet" alias: ${offenders.join(", ")}`
        : "",
    ).toEqual([]);
  });

});

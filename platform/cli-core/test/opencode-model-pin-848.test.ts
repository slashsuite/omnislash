// ob 848: the architect launcher `ob project wire` installs pins the session model before it execs the TUI,
// and a stamp that does not take exits non-zero. No live architect/agent launch
// is needed: a stub `opencode` answers the session API the same way the real
// one does, and anything that is not an API call is the final exec, recorded
// instead of launching a TUI.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "../../..");
const ARCHITECT = join(repoRoot, "apps/cli/opencode/architect-tui.sh");
const MODEL = "deepseek-v4.1-flash";
const PROVIDER = "opencode-go";

// Answers GET /api/session/{id} with a fixed model (mismatched when
// STUB_IGNORE_MODEL=1), records POST .../model, and records the final exec.
const OPENCODE_STUB = `#!/usr/bin/env bash
set -euo pipefail
state="\${STUB_STATE:?}"
if [ "\${1:-}" = "api" ]; then
  verb="\${2:-}"
  path="\${3:-}"
  case "$verb" in
    post)
      case "$path" in
        /api/session) printf '{"data":{"id":"ses_test"}}\\n' ;;
        */model) printf '%s\\n' "$*" >> "$state/model.post" ;;
      esac
      exit 0
      ;;
    get)
      if [ "\${STUB_IGNORE_MODEL:-0}" = "1" ]; then
        printf '{"data":{"agent":"architect","model":{"id":"mimo-v2.6-flash-free"}}}\\n'
      else
        printf '{"data":{"agent":"architect","model":{"id":"%s"}}}\\n' "\${STUB_MODEL:-${MODEL}}"
      fi
      exit 0
      ;;
  esac
fi
printf '%s\\n' "$*" >> "$state/exec"
printf 'EXEC_REACHED %s\\n' "$*"
exit 0
`;

let dir: string;
let env: Record<string, string | undefined>;

function writeStub(name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function run(script: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: dir,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ob848-"));
  writeStub("opencode", OPENCODE_STUB);
  env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_STATE: dir };
  delete env.OB_ARCHITECT_MODEL;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("opencode model pin before the TUI starts (848)", () => {
  test("architect-tui.sh stamps the model, then execs the TUI", () => {
    const r = run(ARCHITECT, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("EXEC_REACHED --session ses_test --auto");
    const post = readFileSync(join(dir, "model.post"), "utf8");
    expect(post).toContain("/api/session/ses_test/model");
    expect(post).toContain(`"id": "${MODEL}"`);
    expect(post).toContain(`"providerID": "${PROVIDER}"`);
  });

  test("architect-tui.sh exits non-zero when the stamp does not take", () => {
    const r = run(ARCHITECT, [], { STUB_IGNORE_MODEL: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`want ${MODEL}`);
    expect(existsSync(join(dir, "exec"))).toBe(false);
  });

  test("OB_ARCHITECT_MODEL picks another provider and model", () => {
    const r = run(ARCHITECT, [], { OB_ARCHITECT_MODEL: "anthropic/claude-opus-5-5", STUB_MODEL: "claude-opus-5-5" });
    expect(r.status).toBe(0);
    const post = readFileSync(join(dir, "model.post"), "utf8");
    expect(post).toContain(`"id": "claude-opus-5-5"`);
    expect(post).toContain(`"providerID": "anthropic"`);
  });

  test("a model without a provider is refused before any session is made", () => {
    const r = run(ARCHITECT, [], { OB_ARCHITECT_MODEL: "claude-opus-5-5" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("<provider>/<model id>");
    expect(existsSync(join(dir, "model.post"))).toBe(false);
  });
});

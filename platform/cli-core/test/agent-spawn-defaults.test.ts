import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../../apps/cli/src/settings.ts";

// #141 — make agent-spawn default DRIFT visible.
// The live `ob config` value and the shipped default in settings.ts are edited in different places
// months apart, with nothing comparing them, so the defaults rotted quietly: spinoff_agent_cmd still
// named `--model sonnet` after the move to Opus 5, and neither builder command carried `--effort` at
// all. Nobody noticed because a default only applies to a FRESH `ob init`.
//
// A test that restates the expected string would be noise, so this asserts the SHAPE the defaults must
// hold instead, which is what actually rotted:
//   1. every claude `*_agent_cmd` default is a `claude` invocation naming an explicit --model AND
//      --effort, so a new one cannot ship leaving either to the ambient session default;
//   2. they all agree with each other, because they all launch BUILDERS — that is the specific
//      half-swept state #141 was in;
//   3. architect_cmd carries NEITHER flag, because it launches a ARCHITECT and is deliberately left on the
//      CLI's own default. Pinning it would be a decision to make openly, not a drive-by consistency fix.
//
// The `opencode_*` keys are a SECOND engine (0023) with a deliberately different shape: TUI builders
// spawn `.opencode/spinoff-tui.sh` (ob 815; `--auto` is inside the wrapper), whose --model/--effort
// come from opencode's own config (no pin). Direct `opencode --auto` strings, if any remain, get
// their own assertion below, separate from the claude sweep.

// `claude --help` on CLI 2.1.212: --effort <level>, one of these.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "ultracode"]);

/** Read `--<flag> <value>` out of a shell-ish command string. Returns null when the flag is absent. */
function flagValue(cmd: string, flag: string): string | null {
  const argv = cmd.split(/\s+/).filter(Boolean);
  const i = argv.indexOf(`--${flag}`);
  if (i === -1) return null;
  const next = argv[i + 1];
  return next && !next.startsWith("-") ? next : null;
}

const agentCmdKeys = Object.keys(DEFAULTS)
  .filter((k) => k.endsWith("_agent_cmd"))
  .sort();
const claudeAgentCmdKeys = agentCmdKeys.filter((k) => DEFAULTS[k]!.split(/\s+/)[0] === "claude");
const opencodeAgentCmdKeys = agentCmdKeys.filter((k) => DEFAULTS[k]!.split(/\s+/)[0] === "opencode");
const opencodeTuiWrapperKeys = agentCmdKeys.filter((k) => DEFAULTS[k]!.includes("spinoff-tui.sh"));

describe("agent-spawn command defaults (#141)", () => {
  test("there is at least one claude *_agent_cmd default to check", () => {
    expect(claudeAgentCmdKeys.length).toBeGreaterThan(0);
  });

  test.each(claudeAgentCmdKeys)("%s spawns claude with an explicit --model and --effort", (key) => {
    const cmd = DEFAULTS[key]!;
    expect(cmd.split(/\s+/)[0], `${key} must spawn the claude CLI`).toBe("claude");

    const model = flagValue(cmd, "model");
    expect(model, `${key} must name an explicit --model <model> (got: ${cmd})`).not.toBeNull();

    const effort = flagValue(cmd, "effort");
    expect(effort, `${key} must name an explicit --effort <level> (got: ${cmd})`).not.toBeNull();
    expect(
      EFFORT_LEVELS.has(effort!),
      `${key} names --effort ${effort}, which is not one of ${[...EFFORT_LEVELS].join("|")}`,
    ).toBe(true);
  });

  test.each(opencodeAgentCmdKeys)(
    "%s spawns opencode with --auto and no claude-only flags",
    (key) => {
      const cmd = DEFAULTS[key]!;
      expect(cmd.split(/\s+/)[0], `${key} must spawn the opencode CLI`).toBe("opencode");
      expect(
        flagValue(cmd, "model"),
        `opencode's model comes from ITS config, not a --model pin (got: ${cmd})`,
      ).toBeNull();
      expect(flagValue(cmd, "effort"), `opencode has no claude --effort flag (got: ${cmd})`).toBeNull();
      expect(
        cmd,
        `${key} must carry --auto, the opencode counterpart of --dangerously-skip-permissions (got: ${cmd})`,
      ).toContain("--auto");
    },
  );

  test("opencode_spinoff_agent_cmd is the TUI wrapper (ob 815)", () => {
    expect(opencodeTuiWrapperKeys).toEqual(["opencode_spinoff_agent_cmd"]);
    const cmd = DEFAULTS.opencode_spinoff_agent_cmd!;
    expect(cmd).toContain("spinoff-tui.sh");
    expect(cmd.includes("mini"), "mini is the wrong UI").toBe(false);
    expect(flagValue(cmd, "agent"), "V2 TUI has no --agent").toBeNull();
    expect(flagValue(cmd, "model"), "builders stay on the machine default").toBeNull();
  });

  test("every claude *_agent_cmd default agrees on model and effort (they all launch builders)", () => {
    const seen = claudeAgentCmdKeys.map((key) => ({
      key,
      model: flagValue(DEFAULTS[key]!, "model"),
      effort: flagValue(DEFAULTS[key]!, "effort"),
    }));
    const first = seen[0]!;
    for (const row of seen.slice(1)) {
      expect(
        `${row.model} ${row.effort}`,
        `${row.key} spawns ${row.model}/${row.effort} but ${first.key} spawns ${first.model}/${first.effort}; both launch builders, so a sweep that moved one must move the other`,
      ).toBe(`${first.model} ${first.effort}`);
    }
  });

  test("architect_cmd is deliberately left unpinned (not a builder)", () => {
    const cmd = DEFAULTS.architect_cmd!;
    expect(cmd.split(/\s+/)[0]).toBe("claude");
    expect(flagValue(cmd, "model"), "architect_cmd must stay on the CLI's own default model").toBeNull();
    expect(flagValue(cmd, "effort"), "architect_cmd must stay on the CLI's own default effort").toBeNull();
  });

  test("opencode_architect_cmd starts full TUI as architect agent (ob 809)", () => {
    const cmd = DEFAULTS.opencode_architect_cmd!;
    expect(cmd).toContain("architect-tui.sh");
    expect(cmd.includes("mini"), "mini is the wrong UI").toBe(false);
    expect(flagValue(cmd, "agent"), "V2 TUI has no --agent").toBeNull();
    expect(cmd.includes("--prompt /architect"), "a slash only fills the picker").toBe(false);
  });
});
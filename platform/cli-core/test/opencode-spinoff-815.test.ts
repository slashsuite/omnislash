import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { getConfig, setConfig } from "../../../apps/cli/src/config.ts";
import {
  DEFAULTS,
  effectiveOpencodeSpinoffAgentCmd,
  LEGACY_OPENCODE_SPINOFF_AGENT_CMD,
} from "../../../apps/cli/src/settings.ts";
import { agentCmdFor } from "../../cli-coord/src/commands/spinoff.ts";

describe("opencode spinoff cmd (815)", () => {
  test("DEFAULTS / agentCmdFor: opencode builder cmd is the TUI wrapper", async () => {
    expect(DEFAULTS.opencode_spinoff_agent_cmd).toContain("spinoff-tui.sh");
    expect(DEFAULTS.opencode_spinoff_agent_cmd).not.toContain("mini");
    expect(DEFAULTS.opencode_spinoff_agent_cmd).not.toContain("--agent");
    expect(DEFAULTS.opencode_spinoff_agent_cmd).not.toContain("opencode --auto");

    const db = freshDb();
    const cmd = await agentCmdFor(db, "opencode");
    expect(cmd).toBe(DEFAULTS.opencode_spinoff_agent_cmd!);
  });

  test("old stored opencode --auto is upgraded; a custom cmd is left alone", async () => {
    expect(effectiveOpencodeSpinoffAgentCmd(null)).toBe(DEFAULTS.opencode_spinoff_agent_cmd!);
    expect(effectiveOpencodeSpinoffAgentCmd(LEGACY_OPENCODE_SPINOFF_AGENT_CMD)).toBe(
      DEFAULTS.opencode_spinoff_agent_cmd!,
    );
    expect(effectiveOpencodeSpinoffAgentCmd("opencode --auto --foo")).toBe("opencode --auto --foo");

    const db = freshDb();
    await setConfig(db, "opencode_spinoff_agent_cmd", LEGACY_OPENCODE_SPINOFF_AGENT_CMD);
    expect(await agentCmdFor(db, "opencode")).toBe(DEFAULTS.opencode_spinoff_agent_cmd!);
    expect(await getConfig(db, "opencode_spinoff_agent_cmd")).toBe(DEFAULTS.opencode_spinoff_agent_cmd!);

    await setConfig(db, "opencode_spinoff_agent_cmd", "opencode --auto --foo");
    expect(await agentCmdFor(db, "opencode")).toBe("opencode --auto --foo");
    expect(await getConfig(db, "opencode_spinoff_agent_cmd")).toBe("opencode --auto --foo");
  });
});

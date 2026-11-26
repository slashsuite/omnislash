import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { getConfig, setConfig } from "../../../apps/cli/src/config.ts";
import { DEFAULTS, effectiveOpencodeArchitectCmd } from "../../../apps/cli/src/settings.ts";
import { architectCmdFor } from "../../cli-coord/src/commands/spinoff.ts";

describe("opencode architect cmd (433)", () => {
  test("DEFAULTS / architectCmdFor: opencode architect cmd pins the architect agent", async () => {
    expect(DEFAULTS.opencode_architect_cmd).toContain("architect-tui.sh");
    expect(DEFAULTS.opencode_architect_cmd).not.toContain("mini");
    expect(DEFAULTS.opencode_architect_cmd).not.toContain("--agent");
    expect(DEFAULTS.opencode_spinoff_agent_cmd).toContain("spinoff-tui.sh");

    const db = freshDb();
    const cmd = await architectCmdFor(db, "opencode");
    expect(cmd).not.toContain("--agent");
    expect(cmd).toBe(DEFAULTS.opencode_architect_cmd!);
  });

  test("unset reads the default; a custom cmd is used as stored (OB-2256: a new key, nothing to upgrade)", async () => {
    expect(effectiveOpencodeArchitectCmd(null)).toBe(DEFAULTS.opencode_architect_cmd!);
    expect(effectiveOpencodeArchitectCmd("opencode --auto /custom")).toBe("opencode --auto /custom");

    const db = freshDb();
    expect(await architectCmdFor(db, "opencode")).toBe(DEFAULTS.opencode_architect_cmd!);
    await setConfig(db, "opencode_architect_cmd", "opencode --auto /custom");
    expect(await architectCmdFor(db, "opencode")).toBe("opencode --auto /custom");
    expect(await getConfig(db, "opencode_architect_cmd")).toBe("opencode --auto /custom");
  });
});

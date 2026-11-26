import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSoulHooks } from "../../../apps/cli/opencode/plugins/ob-soul.ts";

const MODEL = { id: "m" } as never;

async function transform(
  hooks: ReturnType<typeof createSoulHooks>,
  sessionID = "s1",
  system: string[] = ["existing"],
): Promise<string[]> {
  const output = { system: [...system] };
  await hooks["experimental.chat.system.transform"]({ sessionID, model: MODEL }, output);
  return output.system;
}

describe("opencode soul plugin prepends SOUL.md (756)", () => {
  test("fixture SOUL.md is prepended in front of existing system", async () => {
    const hooks = createSoulHooks({ read: () => "Be direct.\nNo filler.\n" });
    const system = await transform(hooks);
    expect(system[0]).toContain("Be direct.");
    expect(system[0]).toContain("No filler.");
    expect(system[1]).toBe("existing");
  });

  test("missing file prepends nothing extra", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-756-missing-"));
    const hooks = createSoulHooks({ worktree: dir });
    const system = await transform(hooks);
    expect(system).toEqual(["existing"]);
  });

  test("empty file prepends nothing extra", async () => {
    const hooks = createSoulHooks({ read: () => "  \n" });
    const system = await transform(hooks);
    expect(system).toEqual(["existing"]);
  });

  test("does not cap — long soul is prepended in full", async () => {
    const body = `Be direct.\n${"x".repeat(5000)}`;
    const hooks = createSoulHooks({ read: () => body });
    const system = await transform(hooks);
    expect(system[0]).toBe(body);
    expect(system[0]!.length).toBeGreaterThan(4000);
  });

});


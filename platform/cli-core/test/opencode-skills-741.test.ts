import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import skills, { createSkillHooks } from "../../../apps/cli/opencode/plugins/ob-skills.ts";

const MODEL = { id: "m" } as never;

const SKILL_ADD =
  "ob add \"skill: pack an architect bar\" --body $'---\\nagent_created: true\\nname: pack-architect-bar\\n---\\n# Skill\\n'";

async function transform(
  hooks: ReturnType<typeof createSkillHooks>,
  sessionID = "s1",
  system: string[] = ["existing"],
): Promise<string[]> {
  const output = { system: [...system] };
  await hooks["experimental.chat.system.transform"]({ sessionID, model: MODEL }, output);
  return output.system;
}

describe("opencode skills plugin files skill tickets (741)", () => {
  test("system.transform prepends the live-turn skill-ticket instruction", async () => {
    const hooks = createSkillHooks();
    const system = await transform(hooks);
    expect(system[0]).toContain("ob add");
    expect(system[0]).toContain("agent_created: true");
    expect(system[0]).toMatch(/no spinoff/i);
    expect(system[0]).toMatch(/skills\/ stay pinned|Git skills/i);
    expect(system[0]).toMatch(/no second model/i);
    expect(system[1]).toBe("existing");
  });

  test("session.idle does not stamp needs-human and does not spawn ob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-741-"));
    const log = join(dir, "log");
    writeFileSync(log, "");
    const bin = join(dir, "ob");
    writeFileSync(
      bin,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    );
    chmodSync(bin, 0o755);
    const prev = process.env.OB_BIN;
    process.env.OB_BIN = bin;
    try {
      const hooks = createSkillHooks();
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
      expect(readFileSync(log, "utf8")).toBe("");
    } finally {
      if (prev === undefined) delete process.env.OB_BIN;
      else process.env.OB_BIN = prev;
    }
  });

  test("idle without a skill ticket this session prepends a backstop on the next transform", async () => {
    const hooks = createSkillHooks();
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const system = await transform(hooks, "s1");
    expect(system[0]).toContain("No skill ticket filed this session");
    expect(system[0]).toContain("ob add");
    expect(system[0]).toContain("agent_created: true");
    expect(system[0]).toMatch(/no second model/i);
  });

  test("ob add with agent_created this session means idle does not prepend a backstop", async () => {
    const hooks = createSkillHooks();
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "s1", callID: "c1", args: { command: SKILL_ADD } },
      { title: "ob add", output: "", metadata: {} },
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const system = await transform(hooks, "s1");
    expect(system[0]).not.toContain("No skill ticket filed this session");
    expect(system[0]).toContain("agent_created: true");
  });

  test("plain ob add or ob memory add does not count as a skill ticket", async () => {
    const hooks = createSkillHooks();
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "s1", callID: "c1", args: { command: "ob add chart the map" } },
      { title: "ob add", output: "", metadata: {} },
    );
    await hooks["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "s1",
        callID: "c2",
        args: { command: "ob memory add prefer bun" },
      },
      { title: "ob memory add", output: "", metadata: {} },
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const system = await transform(hooks, "s1");
    expect(system[0]).toContain("No skill ticket filed this session");
  });

  test("idle backstop is per session", async () => {
    const hooks = createSkillHooks();
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "s-filed", callID: "c1", args: { command: SKILL_ADD } },
      { title: "ob add", output: "", metadata: {} },
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s-filed" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s-idle" } } });
    const filed = await transform(hooks, "s-filed");
    const idle = await transform(hooks, "s-idle");
    expect(filed[0]).not.toContain("No skill ticket filed this session");
    expect(idle[0]).toContain("No skill ticket filed this session");
  });

  test("dispose does not prepend", async () => {
    const hooks = createSkillHooks();
    await hooks.dispose();
    const system = await transform(hooks);
    expect(system).toEqual(["existing"]);
  });

});

const prevBin = process.env.OB_BIN;
afterEach(() => {
  if (prevBin === undefined) delete process.env.OB_BIN;
  else process.env.OB_BIN = prevBin;
});

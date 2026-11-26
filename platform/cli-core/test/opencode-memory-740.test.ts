import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCommandHelp } from "../../../apps/cli/src/cli.ts";
import { MEMORY_CAP_CHARS, MEMORY_PATH_ENV } from "../../../apps/cli/src/memory.ts";
import memory, { createMemoryHooks } from "../../../apps/cli/opencode/plugins/ob-memory.ts";

const MODEL = { id: "m" } as never;

async function transform(
  hooks: ReturnType<typeof createMemoryHooks>,
  sessionID = "s1",
  system: string[] = ["existing"],
): Promise<string[]> {
  const output = { system: [...system] };
  await hooks["experimental.chat.system.transform"]({ sessionID, model: MODEL }, output);
  return output.system;
}

describe("opencode memory plugin prepends MEMORY.md (740)", () => {
  test("system.transform prepends capped bullets in front of existing system", async () => {
    const hooks = createMemoryHooks({ read: () => "- prefer bun\n- no silent skills on main\n" });
    const system = await transform(hooks);
    expect(system[0]).toContain("- prefer bun");
    expect(system[0]).toContain("- no silent skills on main");
    expect(system[1]).toBe("existing");
  });

  test("empty MEMORY.md still prepends the live-turn instruction, not an empty string", async () => {
    const hooks = createMemoryHooks({ read: () => "" });
    const system = await transform(hooks);
    expect(system[0]).toContain("ob memory add");
    expect(system[0]?.trim().length).toBeGreaterThan(0);
    expect(system[1]).toBe("existing");
  });

  test("drops oldest bullets so the prepended file stays at most 4k", async () => {
    const chunk = "x".repeat(500);
    const bullets = Array.from({ length: 12 }, (_, i) => `- ${i}-${chunk}`).join("\n") + "\n";
    const hooks = createMemoryHooks({ read: () => bullets });
    const system = await transform(hooks);
    const block = system[0]!;
    expect(block).toContain("- 11-");
    expect(block.startsWith("- 0-")).toBe(false);
    expect(block).not.toContain("- 0-");
    const filePart = block
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .join("\n");
    expect(filePart.length).toBeLessThanOrEqual(MEMORY_CAP_CHARS);
  });

  test("session.idle does not stamp needs-human and does not spawn ob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-740-"));
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
      const hooks = createMemoryHooks({ read: () => "- a fact\n" });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
      expect(readFileSync(log, "utf8")).toBe("");
    } finally {
      if (prev === undefined) delete process.env.OB_BIN;
      else process.env.OB_BIN = prev;
    }
  });

  test("idle without a memory add this session prepends a backstop on the next transform", async () => {
    const hooks = createMemoryHooks({ read: () => "- a fact\n" });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const system = await transform(hooks, "s1");
    expect(system[0]).toContain("No learning filed this session");
    expect(system[0]).toContain("ob memory add");
    expect(system[0]).toMatch(/no second model/i);
  });

  test("memory add this session means idle does not prepend a backstop", async () => {
    const hooks = createMemoryHooks({ read: () => "- a fact\n" });
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "s1", callID: "c1", args: { command: "ob memory add prefer bun" } },
      { title: "ob memory add", output: "", metadata: {} },
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const system = await transform(hooks, "s1");
    expect(system[0]).not.toContain("No learning filed this session");
    expect(system[0]).toContain("- a fact");
  });

  test("idle backstop is per session", async () => {
    const hooks = createMemoryHooks({ read: () => "" });
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "s-filed", callID: "c1", args: { command: "ob memory add x" } },
      { title: "ob memory add", output: "", metadata: {} },
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s-filed" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s-idle" } } });
    const filed = await transform(hooks, "s-filed");
    const idle = await transform(hooks, "s-idle");
    expect(filed[0]).not.toContain("No learning filed this session");
    expect(idle[0]).toContain("No learning filed this session");
  });

  test("dispose does not prepend", async () => {
    const hooks = createMemoryHooks({ read: () => "- a fact\n" });
    await hooks.dispose();
    const system = await transform(hooks);
    expect(system).toEqual(["existing"]);
  });

  test("reads OMNISLASH_MEMORY_PATH when no read override is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-740-mem-"));
    const path = join(dir, "MEMORY.md");
    writeFileSync(path, "- from xdg file\n");
    const prev = process.env[MEMORY_PATH_ENV];
    process.env[MEMORY_PATH_ENV] = path;
    try {
      const hooks = createMemoryHooks();
      const system = await transform(hooks);
      expect(system[0]).toContain("- from xdg file");
    } finally {
      if (prev === undefined) delete process.env[MEMORY_PATH_ENV];
      else process.env[MEMORY_PATH_ENV] = prev;
    }
  });


  test("HELP says OpenCode prepends MEMORY.md", () => {
    const help = renderCommandHelp("memory");
    expect(help).toContain("memory add");
    expect(help).toContain("OpenCode prepends");
    expect(help.toLowerCase()).not.toContain("not injected into sessions");
  });
});

const prevBin = process.env.OB_BIN;
afterEach(() => {
  if (prevBin === undefined) delete process.env.OB_BIN;
  else process.env.OB_BIN = prevBin;
});

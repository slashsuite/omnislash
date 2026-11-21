import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HANDLERS, renderCommandHelp, renderEnvHelp } from "../../../apps/cli/src/cli.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS, LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { POSTGRES_SERVABLE_COMMANDS } from "../../../apps/cli/src/db/servable.ts";
import { planExecution } from "../../../apps/cli/src/remote.ts";
import {
  MEMORY_CAP_CHARS,
  MEMORY_PATH_ENV,
  appendMemory,
  asBullet,
  capMemory,
  defaultMemoryPath,
  readMemory,
  resolveMemoryPath,
} from "../../../apps/cli/src/memory.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

function stub(answers: Record<string, unknown>) {
  const calls: ApiRequest[] = [];
  const transport: ApiTransport = async (req) => {
    calls.push(req);
    const path = req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!;
    const key = `${req.method} ${path}`;
    if (!(key in answers)) {
      return {
        status: 404,
        body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }),
      };
    }
    return { status: 200, body: JSON.stringify(answers[key]) };
  };
  return { transport, calls };
}

function api(s: ReturnType<typeof stub>) {
  return { api: { base: BASE, token: TOKEN, transport: s.transport } };
}

async function withMemoryPath<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ob-memory-"));
  const path = join(dir, "MEMORY.md");
  const prev = process.env[MEMORY_PATH_ENV];
  process.env[MEMORY_PATH_ENV] = path;
  try {
    return await fn(path);
  } finally {
    if (prev === undefined) delete process.env[MEMORY_PATH_ENV];
    else process.env[MEMORY_PATH_ENV] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MEMORY.md path (739)", () => {
  test("default is XDG ~/.local/share/omnislash/MEMORY.md", () => {
    expect(defaultMemoryPath({})).toBe(join(homedir(), ".local", "share", "omnislash", "MEMORY.md"));
    expect(defaultMemoryPath({ XDG_DATA_HOME: "/xdg" })).toBe("/xdg/omnislash/MEMORY.md");
  });

  test("OMNISLASH_MEMORY_PATH wins when set", () => {
    expect(resolveMemoryPath({ [MEMORY_PATH_ENV]: "/tmp/MEMORY.md" })).toBe("/tmp/MEMORY.md");
    expect(resolveMemoryPath({ [MEMORY_PATH_ENV]: "", XDG_DATA_HOME: "/xdg" })).toBe("/xdg/omnislash/MEMORY.md");
  });
});

describe("MEMORY.md cap (739)", () => {
  test("asBullet flattens whitespace", () => {
    expect(asBullet("  prefer\nbun  ")).toBe("- prefer bun");
  });

  test("drops oldest bullets until at most 4k chars", () => {
    const chunk = "x".repeat(500);
    const bullets = Array.from({ length: 12 }, (_, i) => `- ${i}-${chunk}`);
    const capped = capMemory(bullets.join("\n") + "\n");
    expect(capped.length).toBeLessThanOrEqual(MEMORY_CAP_CHARS);
    expect(capped.startsWith("- 0-")).toBe(false);
    expect(capped).toContain("- 11-");
    expect(capped.endsWith("\n")).toBe(true);
  });

  test("keeps a single oversized newest bullet", () => {
    const huge = `- ${"y".repeat(MEMORY_CAP_CHARS + 50)}\n`;
    const capped = capMemory(huge);
    expect(capped.length).toBeGreaterThan(MEMORY_CAP_CHARS);
    expect(capped).toBe(huge);
  });

  test("appendMemory writes then caps", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-mem-cap-"));
    const path = join(dir, "MEMORY.md");
    try {
      const chunk = "z".repeat(900);
      for (let i = 0; i < 8; i++) appendMemory(`${i}-${chunk}`, path);
      const text = readMemory(path);
      expect(text.length).toBeLessThanOrEqual(MEMORY_CAP_CHARS);
      expect(text).toContain("- 7-");
      expect(text.startsWith("- 0-")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ob memory (739)", () => {
  test("add appends a bullet, show prints the file, and add --type learning the same fact", async () => {
    await withMemoryPath(async (path) => {
      const db = freshDbPath();
      const add = await runCli(db, ["memory", "add", "prefer bun over node"]);
      expect(add.code).toBe(0);
      const id = add.out.trim();
      expect(id).toMatch(/^\d+$/);
      expect(readFileSync(path, "utf8")).toBe("- prefer bun over node\n");

      const shown = await runCli(db, ["memory", "show"]);
      expect(shown.code).toBe(0);
      expect(shown.out).toBe("- prefer bun over node\n");

      const learning = await runCli(db, ["learning", "--json"]);
      expect(learning.code).toBe(0);
      const rows = JSON.parse(learning.out) as Array<{ id: string; title: string; status: string }>;
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id, title: "prefer bun over node", status: "todo" })]));
    });
  });

  test("show of a missing file is empty stdout, exit 0", async () => {
    await withMemoryPath(async () => {
      const r = await runCli(freshDbPath(), ["memory", "show"]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    });
  });

  test("show --json names the path and the text", async () => {
    await withMemoryPath(async (path) => {
      const db = freshDbPath();
      await runCli(db, ["memory", "add", "a fact"]);
      const r = await runCli(db, ["memory", "show", "--json"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ path, text: "- a fact\n" });
    });
  });

  test("add without a fact is usage exit 2", async () => {
    const r = await runCli(freshDbPath(), ["memory", "add"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("memory add requires a <fact>");
  });

  test("unknown subcommand is usage exit 2", async () => {
    const r = await runCli(freshDbPath(), ["memory", "inject"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("memory requires add <fact> or show");
  });
});

describe("classification (739)", () => {
  test("memory is a HANDLER, API-routed split, postgres-servable", () => {
    expect(HANDLERS.memory).toBeDefined();
    expect(API_ROUTED_COMMANDS.has("memory")).toBe(true);
    expect(LOCAL_ONLY_COMMANDS.has("memory")).toBe(false);
    expect(typeof API_HANDLERS.memory).toBe("function");
    expect(POSTGRES_SERVABLE_COMMANDS.has("memory")).toBe(true);
    const help = renderCommandHelp("memory");
    expect(help).toContain("memory add");
    expect(help).toContain("OMNISLASH_MEMORY_PATH");
    expect(renderEnvHelp()).toContain("OMNISLASH_MEMORY_PATH");
  });

  test("with remote_host it is nodb, never dispatched", () => {
    expect(planExecution({ command: "memory", args: ["show"], flags: {}, host: "ob@server" }).mode).toBe("nodb");
    expect(planExecution({ command: "memory", args: ["add", "fact"], flags: {}, host: "ob@server" }).mode).toBe("nodb");
    expect(planExecution({ command: "memory", args: ["show"], flags: {}, host: null }).mode).toBe("local");
  });
});

describe("API client (739)", () => {
  test("show reads the file here and makes no HTTP", async () => {
    await withMemoryPath(async (path) => {
      appendMemory("local only", path);
      const s = stub({});
      const r = await runCli(freshDbPath(), ["memory", "show"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("- local only");
      expect(s.calls).toEqual([]);
    });
  });

  test("add writes the file here and POSTs /items type=learning", async () => {
    await withMemoryPath(async (path) => {
      const s = stub({
        "POST /items": {
          id: "88",
          item: { id: "88", type: "learning", title: "ship the memory store", status: "todo" },
        },
      });
      const r = await runCli(freshDbPath(), ["memory", "add", "ship the memory store"], api(s));
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe("88");
      expect(readFileSync(path, "utf8")).toBe("- ship the memory store\n");
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0]!.method).toBe("POST");
      expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/items`);
      expect(JSON.parse(s.calls[0]!.body!)).toEqual({ type: "learning", title: "ship the memory store" });
    });
  });
});

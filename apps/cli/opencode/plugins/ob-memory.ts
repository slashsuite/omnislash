import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bindV2Hooks, type V2SetupCtx } from "../lib/v2-setup.ts";

const MEMORY_PATH_ENV = "OMNISLASH_MEMORY_PATH";
const MEMORY_CAP_CHARS = 4000;

const MEMORY_HEADER =
  'Always-on memory (this machine). File non-trivial facts with `ob memory add "<fact>"`. Idle is a backstop only (no second model).';

const IDLE_BACKSTOP =
  'No learning filed this session. If the last turn was non-trivial, run `ob memory add "<fact>"`.';

type ToolAfterInput = {
  tool: string;
  sessionID?: string;
  callID?: string;
  args?: Record<string, unknown>;
};

function resolvePath(env: NodeJS.Dict<string | undefined> = process.env): string {
  const override = env[MEMORY_PATH_ENV];
  if (override && override.length > 0) return override;
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "omnislash", "MEMORY.md");
}

function capMemory(text: string, cap: number = MEMORY_CAP_CHARS): string {
  const bullets = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("- "));
  while (bullets.length > 1 && toFile(bullets).length > cap) bullets.shift();
  return toFile(bullets);
}

function toFile(bullets: string[]): string {
  return bullets.length === 0 ? "" : `${bullets.join("\n")}\n`;
}

function defaultRead(): string {
  const path = resolvePath();
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function sessionKey(id: string | undefined): string {
  return id ?? "";
}

function isMemoryAdd(command: string): boolean {
  return /\bmemory\s+add\b/.test(command);
}

function memorySystemBlock(text: string, idleBackstop: boolean): string {
  const capped = capMemory(text).trimEnd();
  const parts = [MEMORY_HEADER];
  if (capped.length > 0) parts.push(capped);
  if (idleBackstop) parts.push(IDLE_BACKSTOP);
  return parts.join("\n\n");
}

export function createMemoryHooks(input: { read?: () => string } = {}) {
  const read = input.read ?? defaultRead;
  const filed = new Set<string>();
  const backstop = new Set<string>();
  let disposed = false;

  return {
    dispose: async () => {
      disposed = true;
    },
    event: async (payload: { event: { type?: string; properties?: { sessionID?: string } } }) => {
      if (disposed) return;
      if (payload.event.type !== "session.idle") return;
      const id = sessionKey(payload.event.properties?.sessionID);
      if (!filed.has(id)) backstop.add(id);
    },
    "tool.execute.after": async (toolInput: ToolAfterInput, _output?: unknown) => {
      if (disposed) return;
      const command = typeof toolInput.args?.command === "string" ? toolInput.args.command : "";
      if (!isMemoryAdd(command)) return;
      const id = sessionKey(toolInput.sessionID);
      filed.add(id);
      backstop.delete(id);
    },
    "experimental.chat.system.transform": async (
      transformInput: { sessionID?: string; model: unknown },
      output: { system: string[] },
    ) => {
      if (disposed) return;
      const id = sessionKey(transformInput.sessionID);
      const idle = backstop.has(id);
      if (idle) backstop.delete(id);
      output.system.unshift(memorySystemBlock(read(), idle));
    },
  };
}

export default {
  id: "ob-memory",
  async setup(ctx: V2SetupCtx) {
    return bindV2Hooks(ctx, createMemoryHooks());
  },
};

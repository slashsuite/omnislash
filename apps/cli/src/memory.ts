import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "./errors.ts";
import { emitId, print, type Mode } from "./output.ts";

export const MEMORY_PATH_ENV = "OMNISLASH_MEMORY_PATH";
export const MEMORY_CAP_CHARS = 4000;

export function defaultMemoryPath(env: NodeJS.Dict<string | undefined> = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "omnislash", "MEMORY.md");
}

export function resolveMemoryPath(env: NodeJS.Dict<string | undefined> = process.env): string {
  const override = env[MEMORY_PATH_ENV];
  if (override && override.length > 0) return override;
  return defaultMemoryPath(env);
}

export function readMemory(path: string = resolveMemoryPath()): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

export function asBullet(fact: string): string {
  const line = fact.replace(/\s+/g, " ").trim();
  return `- ${line}`;
}

export function capMemory(text: string, cap: number = MEMORY_CAP_CHARS): string {
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

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp may never have been created
    }
    throw err;
  }
}

export function appendMemory(fact: string, path: string = resolveMemoryPath()): string {
  const bullet = asBullet(fact);
  if (bullet === "- ") throw new UsageError("memory add requires a <fact>");
  const next = capMemory(`${readMemory(path)}${bullet}\n`);
  writeAtomic(path, next);
  return path;
}

export type MemoryOp = { op: "show" } | { op: "add"; fact: string };

export function parseMemoryArgs(args: string[]): MemoryOp {
  const sub = args[0];
  if (sub === undefined || sub === "show") return { op: "show" };
  if (sub === "add") {
    const fact = args.slice(1).join(" ").trim();
    if (fact.length === 0) throw new UsageError("memory add requires a <fact>");
    return { op: "add", fact };
  }
  throw new UsageError("memory requires add <fact> or show");
}

export async function handleMemory(
  args: string[],
  mode: Mode,
  recordLearning: (fact: string) => Promise<string>,
): Promise<void> {
  const parsed = parseMemoryArgs(args);
  const path = resolveMemoryPath();
  if (parsed.op === "show") {
    const text = readMemory(path);
    if (mode === "json") {
      print(JSON.stringify({ path, text }));
      return;
    }
    if (text.length === 0) return;
    print(text.endsWith("\n") ? text.slice(0, -1) : text);
    return;
  }
  appendMemory(parsed.fact, path);
  const id = await recordLearning(parsed.fact);
  emitId({ mode }, id);
}

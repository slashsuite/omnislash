import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bindV2Hooks, locationPaths, type V2SetupCtx } from "../lib/v2-setup.ts";

function resolvePath(input: { directory?: string; worktree?: string } = {}): string {
  const root = input.worktree || input.directory;
  if (root && root.length > 0) return join(root, ".opencode", "SOUL.md");
  return join(import.meta.dir, "..", "SOUL.md");
}

function defaultRead(input: { directory?: string; worktree?: string } = {}): string {
  const path = resolvePath(input);
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function createSoulHooks(
  input: { read?: () => string; directory?: string; worktree?: string } = {},
) {
  const read = input.read ?? (() => defaultRead(input));
  let disposed = false;

  return {
    dispose: async () => {
      disposed = true;
    },
    "experimental.chat.system.transform": async (
      _transformInput: { sessionID?: string; model: unknown },
      output: { system: string[] },
    ) => {
      if (disposed) return;
      const text = read();
      if (text.trim().length === 0) return;
      output.system.unshift(text.trimEnd());
    },
  };
}

export default {
  id: "ob-soul",
  async setup(ctx: V2SetupCtx) {
    return bindV2Hooks(ctx, createSoulHooks(locationPaths(ctx)));
  },
};

// OS-240: `ob models sync-favorites` reads T3's favourite models on this machine and stores them on the server,
// where the dashboard's Models page reads them as its model dropdowns' options.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  T3FavoritesError,
  T3_FAVORITES_KEY,
  favoritesFromSettings,
  loadFavorites,
  parseStoredFavorites,
  readT3Favorites,
  saveFavorites,
} from "../../../apps/cli/src/t3-favorites.ts";
import type { ConfigIO } from "../../../apps/cli/src/review-readers.ts";

const CLI_ENTRY = join(import.meta.dir, "../../../apps/cli/src/index.ts");

const SETTINGS = JSON.stringify({
  theme: "dark",
  favorites: [
    { provider: "claudeAgent", model: "claude-opus-5-5" },
    { provider: "antigravity", model: "gemini-4-neon" },
    { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
    { provider: "claudeAgent", model: "claude-opus-5-5" },
    { provider: "claudeAgent" },
    "junk",
  ],
});

function memIo(): ConfigIO & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, get: async (k) => data[k] ?? null, set: async (k, v) => void (data[k] = v) };
}

async function withScratch<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-os240-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("OS-240: T3 favourite models", () => {
  test("settings.json favourites read as provider-prefixed ids, in T3's order, each once", () => {
    expect(favoritesFromSettings(SETTINGS)).toEqual(["claudeAgent:claude-opus-5-5", "antigravity:gemini-4-neon", "opencode:opencode-go/deepseek-v4.1-flash"]);
  });

  test("a missing, malformed or favourite-less settings file is refused by name", async () => {
    await withScratch((dir) => {
      expect(() => readT3Favorites(join(dir, "none.json"))).toThrow(/no T3 settings at .*none\.json/);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{");
      expect(() => readT3Favorites(bad)).toThrow(T3FavoritesError);
      expect(() => favoritesFromSettings("{}", "s.json")).toThrow("s.json has no favorites list");
    });
  });

  test("a saved list loads back, and a stored value that does not read is no list", async () => {
    const io = memIo();
    expect(await loadFavorites(io)).toBeNull();
    const saved = await saveFavorites(io, ["claudeAgent:claude-opus-5-5"], new Date("2026-11-26T08:00:00Z"));
    expect(await loadFavorites(io)).toEqual(saved);
    expect(saved).toEqual({ models: ["claudeAgent:claude-opus-5-5"], synced_at: "2026-11-26T08:00:00.000Z" });
    expect(parseStoredFavorites("nope")).toBeNull();
  });

  test("ob models sync-favorites stores this machine's favourites as the server setting", async () => {
    await withScratch((dir) => {
      const db = join(dir, "ob.db");
      const settings = join(dir, "settings.json");
      writeFileSync(settings, SETTINGS);
      const env = {
        ...(process.env as Record<string, string>),
        OMNISLASH_STORE: "sqlite",
        OMNISLASH_DB_CREATE: "1",
        OMNISLASH_DB: db,
        OB_REMOTE: "0",
        OMNISLASH_API: "",
        OMNISLASH_API_URL_FILE: join(dir, "no-api-url"),
        OB_MODELS_FILE: join(dir, "models.jsonc"),
        OB_T3_SETTINGS: settings,
      };
      const run = (args: string[]) => {
        const r = Bun.spawnSync(["bun", CLI_ENTRY, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
        return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
      };
      const r = run(["models", "sync-favorites"]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toContain(`synced 3 T3 favourite models from ${settings} to the server`);

      const row = new Database(db).query("select value from config where key = ?").get(T3_FAVORITES_KEY) as { value: string };
      expect(parseStoredFavorites(row.value)?.models).toEqual(["claudeAgent:claude-opus-5-5", "antigravity:gemini-4-neon", "opencode:opencode-go/deepseek-v4.1-flash"]);

      writeFileSync(settings, JSON.stringify({ favorites: [] }));
      const empty = run(["models", "sync-favorites"]);
      expect(empty.code).not.toBe(0);
      expect(empty.err).toContain("lists no favourite models");
    });
  });
});

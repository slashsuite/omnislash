// OS-240: Jacobus's T3 favourite models, the options of the Models page's model dropdowns. T3 keeps them in its
// settings.json (`favorites: [{provider, model}]`) on the machine he runs T3 on, which is not the server the
// dashboard runs on, so `ob models sync-favorites` reads them there and stores the last list in the server setting
// `t3_favorite_models`. Pure apart from the file read; the store or API goes in as a ConfigIO.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigIO } from "./review-readers.ts";

export const T3_FAVORITES_KEY = "t3_favorite_models";

export interface T3Favorites {
  /** Each favourite as `<provider>:<model>`, in T3's order, each once. */
  models: string[];
  /** When the list was synced (ISO). */
  synced_at: string;
}

export class T3FavoritesError extends Error {}

/** T3's settings file on this machine: `OB_T3_SETTINGS`, else `~/.t3/userdata/settings.json`. */
export function t3SettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OB_T3_SETTINGS?.trim() || join(env.HOME?.trim() || homedir(), ".t3", "userdata", "settings.json");
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/\s/.test(v);

/** The favourites in a settings.json text as `<provider>:<model>`. Entries without both fields are skipped. */
export function favoritesFromSettings(text: string, path = "settings.json"): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new T3FavoritesError(`${path} is not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const favorites = (parsed as { favorites?: unknown } | null)?.favorites;
  if (!Array.isArray(favorites)) throw new T3FavoritesError(`${path} has no favorites list: favourite a model in T3 first`);
  const models = favorites.flatMap((f) => {
    const { provider, model } = (f ?? {}) as { provider?: unknown; model?: unknown };
    return nonEmpty(provider) && nonEmpty(model) ? [`${provider}:${model}`] : [];
  });
  return [...new Set(models)];
}

/** Read this machine's T3 favourites. Throws T3FavoritesError naming the file when it is missing or malformed. */
export function readT3Favorites(path = t3SettingsPath()): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new T3FavoritesError(`no T3 settings at ${path}: run this on the machine T3 Code runs on (or set OB_T3_SETTINGS)`);
  }
  return favoritesFromSettings(text, path);
}

/** The stored list, or null when none was ever synced or the value does not read. */
export function parseStoredFavorites(raw: string | null): T3Favorites | null {
  if (!raw?.trim()) return null;
  try {
    const v = JSON.parse(raw) as Partial<T3Favorites>;
    if (!Array.isArray(v.models) || typeof v.synced_at !== "string") return null;
    return { models: v.models.filter(nonEmpty), synced_at: v.synced_at };
  } catch {
    return null;
  }
}

export async function loadFavorites(io: ConfigIO): Promise<T3Favorites | null> {
  return parseStoredFavorites(await io.get(T3_FAVORITES_KEY));
}

/** Store `models` as the server's favourites, replacing the last list. */
export async function saveFavorites(io: ConfigIO, models: string[], now = new Date()): Promise<T3Favorites> {
  const value: T3Favorites = { models: [...new Set(models)], synced_at: now.toISOString() };
  await io.set(T3_FAVORITES_KEY, JSON.stringify(value));
  return value;
}

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { settingFor } from "../../../../apps/cli/src/settings.ts";
import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { expandHome } from "../../../../apps/cli/src/net.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";
import { readBridgeToken } from "./send.ts";

// ── WhatsApp profile-picture (avatar) proxy (163) ─────────────────────────────────────────────────
// The Go bridge exposes GET /api/avatar?jid=<jid> (Bearer, loopback) → streams the profile-picture image
// bytes (200) or 404 when there's none (163a). ob proxies that fetch so the BROWSER never sees the bridge
// token: the token is read here (server-side, whatsapp_bridge_token_path), sent ONLY to the loopback
// bridge in the Authorization header, and never returned. Avatars change rarely, so a hit is cached to
// disk keyed by jid and served from there within a long TTL — the render never refetches every time. A
// bridge 404 (no picture) surfaces as `null` so the endpoint 404s and the client shows initials. This is
// READ-only plumbing (it never writes the bridge DB) and inherits ob's "only ever talks to localhost"
// posture (the base is whatsapp_bridge_url, a loopback URL).

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8080";

/** Long cache TTL for an avatar (7 days, ms) — profile pictures change rarely, so a hit is reused. */
export const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The avatar bytes + content-type returned to the proxy caller. Never carries the bridge token. */
export interface AvatarResult {
  bytes: Uint8Array;
  contentType: string;
  /** The on-disk cache path. */
  path: string;
}

export interface FetchAvatarOpts {
  jid: string;
  /** Transport seam — tests inject a mock so they NEVER hit the bridge. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** FS read seam — tests inject the cached bytes. Defaults to node readFileSync. */
  readFile?: (path: string) => Uint8Array;
  /** Cache dir override (tests point at a tmp dir). Defaults to whatsapp_avatar_cache_dir / XDG derive. */
  cacheDir?: string;
  /** Injectable clock for TTL tests. Defaults to Date.now. */
  now?: () => number;
}

/** Resolve the avatar cache dir: explicit config, else the OmniSlash XDG data dir's `wa-avatars`. */
export async function avatarCacheDir(store: Store): Promise<string> {
  const explicit = (await settingFor(store, "whatsapp_avatar_cache_dir")).trim();
  if (explicit) return expandHome(explicit);
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "omnislash", "wa-avatars");
}

/** A filesystem-safe token from a jid (strip everything but word chars, dot and dash). Pure. */
function sanitize(s: string): string {
  return s.replace(/[^\w.-]/g, "_");
}

/** The deterministic cache path for a jid's avatar (whatsmeow profile pics are JPEG). */
export function avatarCachePath(dir: string, jid: string): string {
  return join(dir, `${sanitize(jid)}.jpg`);
}

/**
 * Fetch a WhatsApp profile picture as bytes, proxying the bridge's GET /api/avatar?jid=. The bridge token
 * is read here (server-side) and sent ONLY to the loopback bridge — it is NEVER part of the returned
 * AvatarResult. Cache-first with a long TTL: a fresh on-disk hit is served straight from disk (no bridge
 * call); a miss/stale entry calls the bridge, caches the bytes, and serves them. Returns `null` when the
 * bridge has no picture for the jid (404) so the caller 404s and the client shows initials. Throws a clean
 * AppError only on a genuine bridge failure (non-200/404).
 */
export async function fetchWhatsappAvatar(
  store: Store,
  opts: FetchAvatarOpts,
): Promise<AvatarResult | null> {
  const { jid } = opts;
  if (!jid) throw new AppError("avatar proxy requires a jid");

  const dir = opts.cacheDir ?? await avatarCacheDir(store);
  const cachePath = avatarCachePath(dir, jid);
  const readFile = opts.readFile ?? ((p: string) => new Uint8Array(readFileSync(p)));
  const now = opts.now ?? Date.now;

  // Cache hit within TTL — serve straight from disk; never touch the bridge.
  if (existsSync(cachePath) && now() - statSync(cachePath).mtimeMs < AVATAR_TTL_MS) {
    return { bytes: readFile(cachePath), contentType: "image/jpeg", path: cachePath };
  }

  // Miss / stale — proxy the bridge fetch (token stays server-side, sent only to loopback).
  const base = ((await settingFor(store, "whatsapp_bridge_url")) || DEFAULT_BRIDGE_URL).replace(/\/$/, "");
  const token = await readBridgeToken(store);
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${base}/api/avatar?jid=${encodeURIComponent(jid)}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (res.status === 404) return null; // no picture → the caller 404s → the client shows initials
  if (!res.ok) throw new AppError(`WhatsApp bridge avatar fetch failed (${res.status})`);

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const bytes = new Uint8Array(await res.arrayBuffer());
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath, bytes);
  return { bytes, contentType, path: cachePath };
}

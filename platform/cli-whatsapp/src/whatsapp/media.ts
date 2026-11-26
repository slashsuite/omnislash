import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { settingFor } from "../../../../apps/cli/src/settings.ts";
import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { expandHome } from "../../../../apps/cli/src/net.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";
import { readBridgeToken } from "./send.ts";

// ── WhatsApp media download proxy (158 voice notes + 162 images) ──────────────────────────────────
// The Go bridge exposes POST /api/download (Bearer, localhost) which decrypts a message's media, saves
// it under its own store/ and returns {success, filename, path}. ob proxies that fetch so the BROWSER
// never sees the bridge token: the token is read server-side (whatsapp_bridge_token_path), sent ONLY to
// the loopback bridge in the Authorization header, and never returned to the caller. The decrypted
// bytes are cached to disk keyed by (chat_jid, id) so a re-view / a transcribe doesn't refetch. This is
// READ-only plumbing — it never writes the bridge DB and it inherits ob's "only ever talks to localhost"
// posture (the base is whatsapp_bridge_url, a loopback URL).

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8080";

/** The bridge `POST /api/download` response shape. `path` is where the bridge saved the decrypted file. */
export interface BridgeDownloadResponse {
  success?: boolean;
  message?: string;
  filename?: string;
  path?: string;
}

/** The bytes + resolved content-type returned to the proxy caller. Never carries the bridge token. */
export interface MediaResult {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  /** The on-disk cache path (used by the transcriber, which needs a file for the STT engine). */
  path: string;
}

export interface FetchMediaOpts {
  chatJid: string;
  id: string;
  /** Transport seam — tests inject a mock so they NEVER hit the bridge. Defaults to global fetch. */
  fetch?: typeof fetch | undefined;
  /** FS read seam — tests inject the bridge-saved file's bytes. Defaults to node readFileSync. */
  readFile?: ((path: string) => Uint8Array) | undefined;
  /** Cache dir override (tests point at a tmp dir). Defaults to whatsapp_media_cache_dir / XDG derive. */
  cacheDir?: string | undefined;
  /**
   * Write the decrypted bytes into the ob on-disk cache (default true). Status media for a sender
   * who is not a favourite must pass false (629) — the bytes are still returned for on-demand view.
   */
  persist?: boolean | undefined;
}

/** The file extension the bridge writes for a media_type (mirrors the bridge's own switch). Pure. */
export function extForMediaType(mediaType: string | null | undefined): string {
  switch (mediaType) {
    case "image":
      return ".jpg";
    case "sticker":
      return ".webp";
    case "audio":
      return ".ogg";
    case "video":
      return ".mp4";
    default:
      return "";
  }
}

/** HTTP content-type for a file extension. Pure. Falls back to a generic binary type. */
export function contentTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

/** True for the media types the proxy serves as an inline image (162). Pure. */
export function isImageMedia(mediaType: string | null | undefined): boolean {
  return mediaType === "image" || mediaType === "sticker";
}

/** True for the media types the proxy serves as playable/ transcribable audio (158). Pure. */
export function isAudioMedia(mediaType: string | null | undefined): boolean {
  return mediaType === "audio";
}

/** Resolve the media cache dir: explicit config, else the OmniSlash XDG data dir's `wa-media`. */
export async function mediaCacheDir(store: Store): Promise<string> {
  const explicit = (await settingFor(store, "whatsapp_media_cache_dir")).trim();
  if (explicit) return expandHome(explicit);
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "omnislash", "wa-media");
}

/** A filesystem-safe token from a jid/id (strip everything but word chars, dot and dash). Pure. */
function sanitize(s: string): string {
  return s.replace(/[^\w.-]/g, "_");
}

/** The deterministic cache path for a message's media (keyed by chat_jid + id + the media_type ext). */
export function mediaCachePath(dir: string, chatJid: string, id: string, mediaType: string | null): string {
  return join(dir, `${sanitize(chatJid)}__${sanitize(id)}${extForMediaType(mediaType)}`);
}

/** Look up a stored WhatsApp message's media_type (proves it's a real, media-bearing row). */
export async function mediaRow(
  store: Store,
  chatJid: string,
  id: string,
): Promise<{ media_type: string | null } | null> {
  const rows = (await store.q
    .select({ media_type: store.t.whatsappMessage.media_type })
    .from(store.t.whatsappMessage)
    .where(and(eq(store.t.whatsappMessage.chat_jid, chatJid), eq(store.t.whatsappMessage.id, id)))
    .limit(1)) as Array<{ media_type: string | null }>;
  return rows[0] ?? null;
}

/**
 * Fetch a WhatsApp message's media as bytes, proxying the bridge's POST /api/download. The bridge token
 * is read here (server-side) and sent ONLY to the loopback bridge — it is NEVER part of the returned
 * MediaResult. Cache-first: a (chat_jid, id) hit is served straight from disk (no bridge call); a miss
 * calls the bridge, reads the file it saved, copies it into the ob cache, and serves it. Throws a clean
 * AppError when the message/media is unknown or the bridge download fails.
 */
export async function fetchWhatsappMedia(
  store: Store,
  opts: FetchMediaOpts,
): Promise<MediaResult> {
  const { chatJid, id } = opts;
  if (!chatJid || !id) throw new AppError("media proxy requires chat_jid and id");

  const row = await mediaRow(store, chatJid, id);
  if (!row) throw new AppError(`no WhatsApp message ${id} in chat ${chatJid}`);
  if (!row.media_type) throw new AppError(`WhatsApp message ${id} has no media`);

  const dir = opts.cacheDir ?? await mediaCacheDir(store);
  const cachePath = mediaCachePath(dir, chatJid, id, row.media_type);
  const ext = extForMediaType(row.media_type);
  const contentType = contentTypeForExt(ext);
  const readFile = opts.readFile ?? ((p: string) => new Uint8Array(readFileSync(p)));

  // Cache hit — serve straight from disk; never touch the bridge.
  if (existsSync(cachePath)) {
    return { bytes: readFile(cachePath), contentType, filename: `${sanitize(id)}${ext}`, path: cachePath };
  }

  // Miss — proxy the bridge download (token stays server-side, sent only to loopback).
  const base = ((await settingFor(store, "whatsapp_bridge_url")) || DEFAULT_BRIDGE_URL).replace(/\/$/, "");
  const token = await readBridgeToken(store);
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${base}/api/download`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ message_id: id, chat_jid: chatJid }),
  });

  let payload: BridgeDownloadResponse = {};
  try {
    payload = (await res.json()) as BridgeDownloadResponse;
  } catch {
    /* non-JSON body — handled below by the status/success checks */
  }
  if (!res.ok || payload.success === false || !payload.path) {
    throw new AppError(
      `WhatsApp bridge download failed (${res.status})${payload.message ? `: ${payload.message}` : ""}`,
    );
  }

  const bytes = readFile(payload.path);
  const persist = opts.persist !== false;
  if (persist) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath, bytes);
  }
  return {
    bytes,
    contentType,
    filename: payload.filename || `${sanitize(id)}${ext}`,
    path: persist ? cachePath : payload.path,
  };
}

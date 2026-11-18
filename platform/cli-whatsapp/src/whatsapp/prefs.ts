import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { nowIso } from "../../../../apps/cli/src/db.ts";
import { readBool, type Store } from "../../../../apps/cli/src/db/store.ts";
import { canonicalJid, loadLidMap } from "../ingest/whatsapp.ts";

// ── WhatsApp per-chat preferences (169) — hide a chat/person + disable AI suggested replies per chat ──
// Persistent, per-chat control. Keyed by the CANONICAL chat_jid (164): a person's `@lid` privacy-id and
// their `<phone>@s.whatsapp.net` jid share ONE pref row (setting either sets both). Works for groups +
// unmapped numbers too — any jid, not just a mapped `person`. A chat with no row behaves exactly as
// before: shown in the feed + AI-suggested replies enabled. All writes upsert on chat_jid.
//
// hidden / ai_disabled / favorite are plain `integer` flag columns, not drizzle `{ mode: "boolean" }`
// ones, so a write stores the literal 0/1 and a READ goes through `readBool` rather than `!!row?.x`:
// a driver that hands an integer back as a string makes `!!"0"` true, which would report every chat
// hidden and every chat favourited while looking entirely plausible.

/** The resolved preference for one chat. Absent row → all false (default behaviour). */
export interface ChatPref {
  hidden: boolean;
  ai_disabled: boolean;
  favorite: boolean;
}

export interface ChatPrefOpts {
  /** Contacts DB override (tests inject a fixture; runtime derives the lid map read-only + graceful). */
  contacts?: Database;
}

/**
 * Canonicalize a chat jid for pref keying (164). Loads the bridge's lid↔pn map read-only (graceful: an
 * absent/unopenable contacts DB → empty map → the jid passes through unchanged). A non-`@lid` jid and an
 * unmapped `@lid` are returned as-is, so callers can always pass a raw jid.
 */
async function canonPrefJid(store: Store, jid: string, opts: ChatPrefOpts): Promise<string> {
  const lidMap = opts.contacts
    ? await loadLidMap(store, { contacts: opts.contacts })
    : await loadLidMap(store);
  return canonicalJid(jid, lidMap);
}

/** Read one chat's preference (canonicalized). Absent row → { hidden: false, ai_disabled: false, favorite: false }. */
export async function getChatPref(
  store: Store,
  jid: string,
  opts: ChatPrefOpts = {},
): Promise<ChatPref> {
  const chat_jid = await canonPrefJid(store, jid, opts);
  const rows = (await store.q
    .select({
      hidden: store.t.whatsappChatPref.hidden,
      ai_disabled: store.t.whatsappChatPref.ai_disabled,
      favorite: store.t.whatsappChatPref.favorite,
    })
    .from(store.t.whatsappChatPref)
    .where(eq(store.t.whatsappChatPref.chat_jid, chat_jid))
    .limit(1)) as Array<{
    hidden: number | boolean | null;
    ai_disabled: number | boolean | null;
    favorite: number | boolean | null;
  }>;
  const row = rows[0];
  return {
    hidden: readBool(row?.hidden),
    ai_disabled: readBool(row?.ai_disabled),
    favorite: readBool(row?.favorite),
  };
}

/** Upsert a chat's `hidden` flag (canonicalized). Leaves ai_disabled untouched on an existing row. */
export async function setChatHidden(
  store: Store,
  jid: string,
  hidden: boolean,
  opts: ChatPrefOpts = {},
): Promise<void> {
  const chat_jid = await canonPrefJid(store, jid, opts);
  await store.q
    .insert(store.t.whatsappChatPref)
    .values({ chat_jid, hidden: hidden ? 1 : 0, ai_disabled: 0, updated_at: nowIso() })
    .onConflictDoUpdate({
      target: store.t.whatsappChatPref.chat_jid,
      set: { hidden: hidden ? 1 : 0, updated_at: nowIso() },
    });
}

/** Upsert a chat's `ai_disabled` flag (canonicalized). Leaves hidden untouched on an existing row. */
export async function setChatAiDisabled(
  store: Store,
  jid: string,
  aiDisabled: boolean,
  opts: ChatPrefOpts = {},
): Promise<void> {
  const chat_jid = await canonPrefJid(store, jid, opts);
  await store.q
    .insert(store.t.whatsappChatPref)
    .values({ chat_jid, hidden: 0, ai_disabled: aiDisabled ? 1 : 0, updated_at: nowIso() })
    .onConflictDoUpdate({
      target: store.t.whatsappChatPref.chat_jid,
      set: { ai_disabled: aiDisabled ? 1 : 0, updated_at: nowIso() },
    });
}

/** Upsert a chat's `favorite` flag (canonicalized). Leaves hidden + ai_disabled untouched (190a). */
export async function setChatFavorite(
  store: Store,
  jid: string,
  favorite: boolean,
  opts: ChatPrefOpts = {},
): Promise<void> {
  const chat_jid = await canonPrefJid(store, jid, opts);
  await store.q
    .insert(store.t.whatsappChatPref)
    .values({ chat_jid, hidden: 0, ai_disabled: 0, favorite: favorite ? 1 : 0, updated_at: nowIso() })
    .onConflictDoUpdate({
      target: store.t.whatsappChatPref.chat_jid,
      set: { favorite: favorite ? 1 : 0, updated_at: nowIso() },
    });
}

/** One `ob whatsapp` chat action, whichever side of the API runs it. */
export async function applyChatPref(store: Store, jid: string, action: "hide" | "show" | "ai-off" | "ai-on" | "favorite" | "unfavorite"): Promise<void> {
  if (action === "hide") await setChatHidden(store, jid, true);
  else if (action === "show") await setChatHidden(store, jid, false);
  else if (action === "ai-off") await setChatAiDisabled(store, jid, true);
  else if (action === "ai-on") await setChatAiDisabled(store, jid, false);
  else if (action === "favorite") await setChatFavorite(store, jid, true);
  else await setChatFavorite(store, jid, false);
}

/**
 * The canonical jids of every hidden chat. Used by the dashboard's "show hidden" fetch + scripting.
 *
 * The predicate is `eq(col, 1)`, NOT `eq(col, true)`: these are int4 columns, and comparing one with a
 * boolean is an outright Postgres type error rather than a wrong answer.
 */
export async function listHiddenChats(store: Store): Promise<string[]> {
  return (
    (await store.q
      .select({ chat_jid: store.t.whatsappChatPref.chat_jid })
      .from(store.t.whatsappChatPref)
      .where(eq(store.t.whatsappChatPref.hidden, 1))) as Array<{ chat_jid: string }>
  ).map((r) => r.chat_jid);
}

/** The canonical jids of every favourited chat (190a). Used by scripting + the `ob whatsapp` CLI. */
export async function listFavoriteChats(store: Store): Promise<string[]> {
  return (
    (await store.q
      .select({ chat_jid: store.t.whatsappChatPref.chat_jid })
      .from(store.t.whatsappChatPref)
      .where(eq(store.t.whatsappChatPref.favorite, 1))) as Array<{ chat_jid: string }>
  ).map((r) => r.chat_jid);
}

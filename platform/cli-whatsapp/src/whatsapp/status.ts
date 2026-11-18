import type { Database } from "bun:sqlite";
import { and, desc, eq, gte, inArray, isNull, lt, max, or } from "drizzle-orm";
import { listPersonsFor } from "../../../../apps/cli/src/commands/person.ts";
import { readBool, type Store } from "../../../../apps/cli/src/db/store.ts";
import {
  canonicalJid,
  isConversationJid,
  jidLocalPart,
  loadContactNames,
  loadLidMap,
  latestPerChat,
  loadOwnJids,
  resolveChatName,
} from "../ingest/whatsapp.ts";
import { fetchWhatsappMedia } from "./media.ts";
import { listFavoriteChats } from "./prefs.ts";

// ── WhatsApp Status tray (629) ───────────────────────────────────────────────────────────────────
// Status posts live on `status@broadcast` (already ingested; 175 still hides that jid from the chat
// feed and thread view). This module is the READ surface for the dashboard Status tab: others' image
// + video posts, grouped per person, current = last 24h, history via a `before` page. View-only —
// nothing here sends, replies, or reacts. Favourite chats (190) gate media persistence: prefetch +
// keep favourite current media; everyone else is on-demand and must not be written to the ob cache.

export const STATUS_JID = "status@broadcast";
export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const TRAY_ITEM_CAP = 500;
const HISTORY_FETCH_CAP = 200;

export function isStatusJid(jid: string): boolean {
  return jid === STATUS_JID;
}

export function isStatusMediaType(mediaType: string | null | undefined): boolean {
  return mediaType === "image" || mediaType === "video";
}

export function statusCutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() - STATUS_TTL_MS).toISOString();
}

export function isCurrentStatus(ts: string, now: Date = new Date()): boolean {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < STATUS_TTL_MS;
}

export interface StatusItem {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender: string;
  ts: string;
  media_type: string | null;
  content: string | null;
  favorite: boolean;
}

export interface StatusPerson {
  sender_jid: string;
  name: string;
  favorite: boolean;
  latest_ts: string;
  items: StatusItem[];
}

export interface StatusPage {
  people: StatusPerson[];
  hasMore: boolean;
}

export interface StatusReadOpts {
  contacts?: Database;
  now?: Date;
  limit?: number;
  before?: string;
  senderJid?: string;
}

interface StatusRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  content: string | null;
  ts: string | null;
  is_from_me: number | boolean | null;
  person_id: number | null;
  media_type: string | null;
}

const STATUS_COLUMNS = (t: Store["t"]) =>
  ({
    id: t.whatsappMessage.id,
    chat_jid: t.whatsappMessage.chat_jid,
    sender_jid: t.whatsappMessage.sender_jid,
    content: t.whatsappMessage.content,
    ts: t.whatsappMessage.ts,
    is_from_me: t.whatsappMessage.is_from_me,
    person_id: t.whatsappMessage.person_id,
    media_type: t.whatsappMessage.media_type,
  }) as const;

function inboundNotMe(t: Store["t"]) {
  return or(eq(t.whatsappMessage.is_from_me, 0), isNull(t.whatsappMessage.is_from_me));
}

function mediaImageOrVideo(t: Store["t"]) {
  return inArray(t.whatsappMessage.media_type, ["image", "video"]);
}

interface NameSources {
  lidMap: Map<string, string>;
  ownJids: Set<string>;
  favSet: Set<string>;
  nameById: Map<number, string>;
  nameByJid: Map<string, string>;
  contactNames: Map<string, string>;
  chatNames: Map<string, string>;
  chatListNames: Map<string, string>;
}

function putName(map: Map<string, string>, jid: string, name: string, lidMap: Map<string, string>): void {
  const n = name.trim();
  if (!n) return;
  const canon = canonicalJid(jid, lidMap);
  if (!map.has(canon)) map.set(canon, n);
  const local = jidLocalPart(canon);
  if (local && !map.has(local)) map.set(local, n);
}

function lookupName(map: Map<string, string>, jid: string, lidMap: Map<string, string>): string | null {
  const canon = canonicalJid(jid, lidMap);
  return map.get(canon) ?? map.get(jid) ?? map.get(jidLocalPart(canon)) ?? null;
}

function foldJidMap(raw: Map<string, string>, lidMap: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [jid, value] of raw) putName(out, jid, value, lidMap);
  return out;
}

async function loadConversationChatNames(
  store: Store,
  lidMap: Map<string, string>,
  senderJids: string[],
): Promise<Map<string, string>> {
  const list = [
    ...new Set(
      senderJids.flatMap((j) => {
        const canon = canonicalJid(j, lidMap);
        const local = jidLocalPart(canon);
        return [j, canon, `${local}@s.whatsapp.net`, `${local}@lid`];
      }),
    ),
  ];
  if (list.length === 0) return new Map();
  const t = store.t;
  const latest = store.q
    .select({
      chat_jid: t.whatsappMessage.chat_jid,
      mts: max(t.whatsappMessage.ts).as("mts"),
    })
    .from(t.whatsappMessage)
    .where(inArray(t.whatsappMessage.chat_jid, list))
    .groupBy(t.whatsappMessage.chat_jid)
    .as("status_chat_latest");
  const rows = (await store.q
    .select({
      chat_jid: t.whatsappMessage.chat_jid,
      chat_name: t.whatsappMessage.chat_name,
    })
    .from(t.whatsappMessage)
    .innerJoin(
      latest,
      and(eq(t.whatsappMessage.chat_jid, latest.chat_jid), eq(t.whatsappMessage.ts, latest.mts)),
    )) as Array<{ chat_jid: string; chat_name: string | null }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!isConversationJid(r.chat_jid)) continue;
    const name = r.chat_name?.trim();
    if (!name) continue;
    putName(out, r.chat_jid, name, lidMap);
  }
  return out;
}

async function loadNameSources(
  store: Store,
  contacts: Database | undefined,
  senderJids: string[],
): Promise<NameSources> {
  const contactOpts = contacts ? { contacts } : {};
  const lidMap = await loadLidMap(store, contactOpts);
  const ownJids = await loadOwnJids(store, contactOpts);
  const contactNames = foldJidMap(await loadContactNames(store, contactOpts), lidMap);
  const favSet = new Set<string>();
  for (const j of await listFavoriteChats(store)) {
    const canon = canonicalJid(j, lidMap);
    favSet.add(canon);
    const local = jidLocalPart(canon);
    if (local) favSet.add(local);
  }
  const persons = await listPersonsFor(store);
  const nameById = new Map(persons.map((p) => [p.id, p.real_name]));
  const nameByJid = new Map<string, string>();
  for (const p of persons) {
    if (!p.whatsapp_jid) continue;
    putName(nameByJid, p.whatsapp_jid, p.real_name, lidMap);
  }
  const chatNames = await loadConversationChatNames(store, lidMap, senderJids);
  const chatListNames = new Map<string, string>();
  const chats = await latestPerChat(store, { contacts, limit: 10_000, includeHidden: true });
  for (const c of chats) {
    putName(chatListNames, c.chat_jid, c.name, lidMap);
    if (c.favorite) {
      favSet.add(canonicalJid(c.chat_jid, lidMap));
      const local = jidLocalPart(c.chat_jid);
      if (local) favSet.add(local);
    }
  }
  return { lidMap, ownJids, favSet, nameById, nameByJid, contactNames, chatNames, chatListNames };
}

function senderName(r: StatusRow, canon: string, src: NameSources): string {
  const fromChats = lookupName(src.chatListNames, canon, src.lidMap);
  if (fromChats) return fromChats;
  const personName =
    (r.person_id != null ? src.nameById.get(r.person_id) : undefined) ??
    lookupName(src.nameByJid, canon, src.lidMap);
  return resolveChatName({
    chatJid: canon,
    chatName: lookupName(src.chatNames, canon, src.lidMap),
    personName,
    contactName: lookupName(src.contactNames, canon, src.lidMap),
  });
}

function groupPeople(rows: StatusRow[], src: NameSources): StatusPerson[] {
  const itemsBySender = new Map<string, StatusItem[]>();
  const meta = new Map<string, { name: string; favorite: boolean }>();
  for (const r of rows) {
    if (readBool(r.is_from_me)) continue;
    if (!r.sender_jid || !r.ts) continue;
    if (!isStatusMediaType(r.media_type)) continue;
    const canon = canonicalJid(r.sender_jid, src.lidMap);
    if (src.ownJids.has(jidLocalPart(canon))) continue;
    const favorite = src.favSet.has(canon) || src.favSet.has(jidLocalPart(canon));
    const name = senderName(r, canon, src);
    const item: StatusItem = {
      id: r.id,
      chat_jid: STATUS_JID,
      sender_jid: canon,
      sender: name,
      ts: r.ts,
      media_type: r.media_type,
      content: r.content,
      favorite,
    };
    const list = itemsBySender.get(canon) ?? [];
    list.push(item);
    itemsBySender.set(canon, list);
    meta.set(canon, { name, favorite });
  }
  const people: StatusPerson[] = [];
  for (const [sender_jid, items] of itemsBySender) {
    items.sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));
    const m = meta.get(sender_jid)!;
    people.push({
      sender_jid,
      name: m.name,
      favorite: m.favorite,
      latest_ts: items[0]!.ts,
      items,
    });
  }
  people.sort((a, b) => b.latest_ts.localeCompare(a.latest_ts) || a.sender_jid.localeCompare(b.sender_jid));
  return people;
}

/** Current Status tray: last 24h, others only, image + video, grouped per person. */
export async function statusTray(store: Store, opts: StatusReadOpts = {}): Promise<StatusPage> {
  const now = opts.now ?? new Date();
  const cutoff = statusCutoffIso(now);
  const t = store.t;
  const rows = (await store.q
    .select(STATUS_COLUMNS(t))
    .from(t.whatsappMessage)
    .where(
      and(
        eq(t.whatsappMessage.chat_jid, STATUS_JID),
        mediaImageOrVideo(t),
        inboundNotMe(t),
        gte(t.whatsappMessage.ts, cutoff),
      ),
    )
    .orderBy(desc(t.whatsappMessage.ts), desc(t.whatsappMessage.id))
    .limit(TRAY_ITEM_CAP)) as StatusRow[];

  const src = await loadNameSources(
    store,
    opts.contacts,
    rows.flatMap((r) => (r.sender_jid ? [r.sender_jid] : [])),
  );
  const people = groupPeople(rows, src);

  const older = (await store.q
    .select({ id: t.whatsappMessage.id })
    .from(t.whatsappMessage)
    .where(
      and(
        eq(t.whatsappMessage.chat_jid, STATUS_JID),
        mediaImageOrVideo(t),
        inboundNotMe(t),
        lt(t.whatsappMessage.ts, cutoff),
      ),
    )
    .limit(1)) as Array<{ id: string }>;

  return { people, hasMore: older.length > 0 };
}

/** Older Status posts strictly before `before` (history page). Items grouped per person, oldest→newest. */
export async function statusHistoryPage(store: Store, opts: StatusReadOpts): Promise<StatusPage> {
  const before = opts.before;
  if (!before) return statusTray(store, opts);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
  const t = store.t;
  const lidMap = await loadLidMap(store, opts.contacts ? { contacts: opts.contacts } : {});
  const senderJids = opts.senderJid
    ? [
        ...new Set(
          [opts.senderJid, canonicalJid(opts.senderJid, lidMap)].flatMap((j) => {
            const local = jidLocalPart(j);
            return [j, `${local}@s.whatsapp.net`, `${local}@lid`];
          }),
        ),
      ]
    : null;
  const rows = (await store.q
    .select(STATUS_COLUMNS(t))
    .from(t.whatsappMessage)
    .where(
      and(
        eq(t.whatsappMessage.chat_jid, STATUS_JID),
        mediaImageOrVideo(t),
        inboundNotMe(t),
        lt(t.whatsappMessage.ts, before),
        ...(senderJids ? [inArray(t.whatsappMessage.sender_jid, senderJids)] : []),
      ),
    )
    .orderBy(desc(t.whatsappMessage.ts), desc(t.whatsappMessage.id))
    .limit(senderJids ? limit + 1 : HISTORY_FETCH_CAP)) as StatusRow[];

  const src = await loadNameSources(
    store,
    opts.contacts,
    rows.flatMap((r) => (r.sender_jid ? [r.sender_jid] : [])),
  );
  const filtered = rows.filter((r) => {
    if (readBool(r.is_from_me) || !r.sender_jid || !r.ts) return false;
    const canon = canonicalJid(r.sender_jid, src.lidMap);
    return !src.ownJids.has(jidLocalPart(canon));
  });
  const windowed = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;
  windowed.reverse();
  return { people: groupPeople(windowed, src), hasMore };
}

/**
 * Whether a media proxy fetch should write the ob on-disk cache (629). Chat media always persists.
 * Status media persists only when the sender's 1:1 chat is a favourite. Unknown / unattributable
 * Status senders do not persist.
 */
export async function shouldPersistWhatsappMedia(
  store: Store,
  chatJid: string,
  id: string,
  opts: { contacts?: Database } = {},
): Promise<boolean> {
  if (!isStatusJid(chatJid)) return true;
  const rows = (await store.q
    .select({ sender_jid: store.t.whatsappMessage.sender_jid })
    .from(store.t.whatsappMessage)
    .where(and(eq(store.t.whatsappMessage.chat_jid, chatJid), eq(store.t.whatsappMessage.id, id)))
    .limit(1)) as Array<{ sender_jid: string | null }>;
  const sender = rows[0]?.sender_jid;
  if (!sender) return false;
  const lidMap = await loadLidMap(store, opts.contacts ? { contacts: opts.contacts } : {});
  const canon = canonicalJid(sender, lidMap);
  const favs = await listFavoriteChats(store);
  return favs.map((j) => canonicalJid(j, lidMap)).includes(canon);
}

export interface PrefetchStatusMediaOpts {
  contacts?: Database;
  now?: Date;
  fetch?: typeof fetch;
  cacheDir?: string;
}

/** Prefetch current Status media for favourite senders into the ob cache. Best-effort; never throws. */
export async function prefetchFavoriteStatusMedia(
  store: Store,
  opts: PrefetchStatusMediaOpts = {},
): Promise<number> {
  let saved = 0;
  try {
    const { people } = await statusTray(store, { contacts: opts.contacts, now: opts.now });
    for (const person of people) {
      if (!person.favorite) continue;
      for (const item of person.items) {
        if (!isStatusMediaType(item.media_type)) continue;
        try {
          await fetchWhatsappMedia(store, {
            chatJid: item.chat_jid,
            id: item.id,
            persist: true,
            fetch: opts.fetch,
            cacheDir: opts.cacheDir,
          });
          saved += 1;
        } catch {
          /* bridge down / expired media — skip this item */
        }
      }
    }
  } catch {
    /* tray unreadable — sync still succeeded */
  }
  return saved;
}

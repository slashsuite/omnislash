// Client mirrors of the server snapshot shapes (src/realtime.ts → Snapshot). Kept as a plain
// duplicate so the client bundle never imports server/bun code. Only the fields the UI renders.

export interface AgentRow {
  id: string;
  ticket: string | null;
  branch: string | null;
  status: string;
  /** T3's run word (1189), present for a `t3` row the mirror has reached; separate from `status` on the
   *  wire and joined only for the human line. Optional: a snapshot from an older host lacks the field. */
  run?: string | null;
  note?: string | null;
}

export interface InFlightPr {
  pr: string;
  title: string | null;
  url: string | null;
  state: "authoring" | "waiting-review" | "addressing-comments";
  additions: number;
  deletions: number;
  branch_age_days: number | null;
}

export interface OpenItem {
  id: string;
  title: string;
  status: string;
  priority: string | null; // (QW1) human name (urgent|flake|high|medium|low), or null when unset — drives the priority pill
  block_reason: string | null;
  block_owner: string | null;
  today_rank: number | null;
}

export interface StatusSnapshot {
  agents: AgentRow[];
  needs_review: AgentRow[];
  working: AgentRow[];
  in_flight_prs: InFlightPr[];
  blocked: OpenItem[];
  focus: OpenItem[];
  // (QW2) `url` is the GitHub issue URL — already on the wire (WayfinderTicket.url rides buildStatus's
  // frontier), just surfaced to the client type so a frontier row can link out to its issue.
  frontier: { takeable: { id: number; title: string; url?: string | null }[]; blocked: number } | null;
  journal: { type: string; text: string; about?: string | null }[];
}

export interface Spinoff {
  id: number;
  ticket_ref: string;
  /** The ob ITEM this row serves (1163); `ticket_ref` is only the ref it was DISPATCHED with, which for a
   *  hand-charted ticket is its wayfinder number rather than the mirror's id. Optional: a row from an API
   *  host older than 0032 has no such field. */
  item_id?: string | null;
  branch: string;
  status: string; // stored pending|launching|launched|ready-for-gate|merged|failed (printed queued|launching|building|handed-off|landed|failed, 1513)
  error?: string | null;
}

export interface StandupDoc {
  date: string;
  generated_md: string | null;
  edited_md: string | null;
  effective_md: string | null;
  status: string; // generated | edited | posted
  generated_at: string | null;
  edited_at: string | null;
  posted_at: string | null;
}

// A chat-list row (156): the latest message per chat, with a resolved display name. Mirrors the
// server's WhatsappChatItem (src/ingest/whatsapp.ts) — one row per chat, not per message.
export interface WhatsappFeedItem {
  chat_jid: string;
  name: string; // resolved display name (person > whatsmeow contact > chat_name > jid)
  preview: string | null; // truncated last-message preview (null for media / empty bodies)
  ts: string | null; // last-message timestamp
  is_from_me: number; // 1 when the last message was outbound (from me), else 0
  person_id: number | null; // the chat partner's person id (1:1 chats), else null
  id: string; // the latest message's bridge id — the media proxy / transcribe key (with chat_jid)
  media_type: string | null; // "image" | "sticker" | "audio" | "reaction" | ... when the latest message is media (158/162)
  media_desc: string | null; // AI vision caption of an image (198b), when the latest message is an image; else null (#49)
  transcript: string | null; // a voice note's stored transcript (158), when transcribed; else null
  hidden: boolean; // per-chat pref (169): this chat is hidden from the feed (true only in the hidden list)
  ai_disabled: boolean; // per-chat pref (169): AI-suggested replies are disabled for this chat
  favorite: boolean; // per-chat pref (190a): this chat is a favourite — the feed shows favourites-first
  status: string | null; // latest message's delivery/read receipt (186b): sent | delivered | read | played; NULL = inbound
}

// One Status post (629) — WhatsApp Status / stories, not delivery ticks. Mirrors the server's StatusItem.
export interface WhatsappStatusItem {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender: string;
  ts: string;
  media_type: string | null;
  content: string | null;
  favorite: boolean;
}

// One person's current (or history-page) Status filmstrip (629).
export interface WhatsappStatusPerson {
  sender_jid: string;
  name: string;
  favorite: boolean;
  latest_ts: string;
  items: WhatsappStatusItem[];
}

// One rendered thread message (168) — the on-demand per-chat thread panel. Mirrors the server's
// ThreadItem (src/ingest/whatsapp.ts): a resolved author `sender` ("you" for outbound, else the
// resolved name) plus content/preview + the media proxy key (chat_jid + id + media_type). Fetched from
// the ob sidecar's GET /api/whatsapp/thread, never carried on the WS snapshot.
export interface WhatsappThreadItem {
  id: string; // the bridge message id — the media proxy / transcribe key (with chat_jid)
  chat_jid: string; // the canonical chat jid (@lid/phone unified)
  sender: string; // "you" for outbound, else resolved name / chat_name / shortened jid
  sender_jid: string | null; // the per-message participant jid (189: name-on-change grouping key)
  is_from_me: number; // 1 when outbound (from me), else 0
  ts: string | null; // message timestamp
  content: string | null; // full message body (null for media / empty); for a reaction, the emoji (#50)
  preview: string | null; // truncated preview (null for media / empty bodies)
  media_type: string | null; // "image" | "sticker" | "audio" | "reaction" | ... when the message is media (158/162)
  media_desc: string | null; // AI vision caption of an image (198b), muted/italic under the thumb; else null (#49)
  quoted_message_id: string | null; // reply target; for a reaction (media_type="reaction") the reacted-to message id (#50)
  transcript: string | null; // a voice note's stored transcript (158), when transcribed; else null
  status: string | null; // delivery/read receipt (186b): sent | delivered | read | played; NULL = inbound
  // #50: reactions folded onto this message by attachReactions (client-side). Reaction rows are NOT
  // rendered standalone — each reacted-to message carries its reactions here as small badges instead.
  reactions?: ThreadReaction[];
}

// #50: one emoji reaction pinned to the message it reacts to. Derived client-side (attachReactions) from
// reaction rows (media_type="reaction", emoji in content, target in quoted_message_id) — never a row.
export interface ThreadReaction {
  id: string; // the reaction message's own id
  emoji: string; // the reaction emoji (a removed reaction — empty emoji — is dropped, never shown)
  sender: string; // who reacted ("you" for outbound)
  is_from_me: number; // 1 when I reacted, else 0
}

// The item-drawer detail (#46 — UI F5). Client mirror of the server's ItemDetail (server/ob.ts →
// getItem): the `ob show`-level composition — item fields + tags + links + linear ref + type detail +
// the activity trail + associated PRs, plus the validated next-status set that drives which drawer
// action buttons enable. Plain shape so the client bundle never pulls in server/bun code.
export interface ItemDetailLink {
  rel_type: string;
  other: string;
  direction: "out" | "in";
}

export interface ItemDetailEvent {
  id: number;
  ts: string;
  source: string | null;
  type: string | null;
  actor: string | null;
  cause: string | null;
}

export interface ItemDetailPr {
  pr: string;
  url: string | null;
  latest_type: string | null;
  ts: string | null;
}

export interface ItemDetailLinear {
  linear_id: string | null;
  url: string | null;
  cached_title: string | null;
  cached_state: string | null;
}

export interface ItemDetail {
  id: string;
  type: string;
  title: string;
  status: string;
  priority: string | null;
  effective_priority: string;
  /** OS-216: the open item this one blocks that raised its effective priority, when one did. */
  raised_by?: string;
  today_rank: number | null;
  project: string | null;
  kind: string | null;
  block_reason: string | null;
  block_owner: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  body: string | null;
  tags: string[];
  links: ItemDetailLink[];
  linear: ItemDetailLinear | null;
  detail: Record<string, string | number | boolean | null> | null;
  events: ItemDetailEvent[];
  prs: ItemDetailPr[];
  /** Valid next statuses per the per-type/kind state model — drives which action buttons enable. */
  valid_next: string[];
}

// A today's-agenda calendar row (#47 — UI F2). Plain client mirror of the server's AgendaRow
// (src/ingest/calendar.ts → agendaToday) so the client bundle never imports server/bun code.
export interface AgendaItem {
  id: string;
  calendar_id: string;
  summary: string | null;
  start_ts: string | null;
  end_ts: string | null;
  all_day: number | null;
  person_id: number | null;
}

export interface Snapshot {
  at: string;
  status: StatusSnapshot;
  standupDoc: StandupDoc | null;
  lastStandupAt: string | null;
  spinoffs: Spinoff[];
  agents: AgentRow[];
  whatsapp: WhatsappFeedItem[];
  whatsappStatus: WhatsappStatusPerson[]; // current Status tray (629) — live; history is on-demand
  alertCount: number; // (#45) live count of un-acked alerts — drives the header bell
  branchAgeMax: number; // (QW6) stale-branch threshold in days (alert rule 3) — drives the PR "stale" chip
  /** OS-25: the item count and latest updated_at. Any item write moves it (an `ob order` stamps the moved item), so the
   *  Queue page re-reads its list when it changes. Optional: an API host older than OS-25 sends none. */
  itemsStamp?: string;
  /** OS-241: the decision count and newest id; an `ob spinoff check` moves it, so the Machine page re-reads. Optional: an older API host sends none. */
  decisionsStamp?: string;
  /** OS-312: the scheduled job count, newest job updated_at and newest run id; a job write or a run moves it, so /schedules re-reads. Optional: an older API host sends none. */
  schedulesStamp?: string;
}

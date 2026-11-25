import type { ServerWebSocket } from "bun";
import { nowIso } from "./db.ts";
import { listSpinoffs, type SpinoffRow } from "../../../platform/cli-coord/src/commands/spinoff.ts";
import type { AgentStatusRow } from "../../../platform/cli-coord/src/agent.ts";
import { buildStatus, type StatusSnapshot } from "./commands/status.ts";
import type { IssueFetcher } from "./wayfinder.ts";
import { latestStandup, effectiveText, lastStandupAt, type StandupRow } from "./commands/standup.ts";
import { latestPerChat, threadPageForChat, type WhatsappChatItem } from "../../../platform/cli-whatsapp/src/ingest/whatsapp.ts";
import { fetchWhatsappMedia } from "../../../platform/cli-whatsapp/src/whatsapp/media.ts";
import {
  statusHistoryPage,
  statusTray,
  shouldPersistWhatsappMedia,
  type StatusPerson,
} from "../../../platform/cli-whatsapp/src/whatsapp/status.ts";
import { fetchWhatsappAvatar } from "../../../platform/cli-whatsapp/src/whatsapp/avatar.ts";
import { transcribeWhatsappMessage } from "../../../platform/cli-whatsapp/src/whatsapp/transcribe.ts";
import { AppError } from "./errors.ts";
import { itemsStamp } from "./items.ts";
import { decisionsStamp } from "./decisions.ts";
import { getStore, type Store } from "./db/store.ts";
import { computeAlerts, filterSnoozed } from "./commands/alerts.ts";
import { getFocusProject } from "./config.ts";
import { settingNumFor } from "./settings.ts";
import { WEB_BIND_DEFAULT } from "./web-bind.ts";

/** The stored standup doc (086) + its effective text, for the editable surface (088). */
export type StandupDoc = StandupRow & { effective_md: string | null };

/**
 * One row of the read-only WhatsApp dashboard feed (156): a CHAT-LIST row (the latest message per chat,
 * WhatsApp-home style), not a per-message row. `name` is resolved read-only from the person registry and
 * the bridge's whatsmeow contacts (see resolveChatName), falling back to chat_name / a shortened jid —
 * never a raw phone number. Structurally identical to WhatsappChatItem (the ingest reader's shape).
 */
export type WhatsappFeedItem = WhatsappChatItem;

const WHATSAPP_FEED_LIMIT = 50;

// Realtime layer (083). A standalone Bun.serve WebSocket sidecar (second port) — deliberately NOT
// wired into the TanStack/Vite server (avoids its bleeding-edge build coupling; pure Bun). Push
// granularity = whole snapshot.
//
// CHANGE DETECTION, and why it changed (337). It used to be fs.watch on the database FILE: the DB is
// written out-of-process (CLI + daemon), and watching the file caught every writer with zero
// writer-side changes. Postgres has no such file. The failure that would have caused is the worst
// shape available -- fs.watch on a path nothing writes never fires and never errors, so the dashboard
// would have kept serving, kept its socket open, and silently stopped live-updating. Nobody would have
// filed that as a bug for weeks; they would have refreshed the page.
//
// So detection is now a POLL that pushes only when the snapshot actually differs. It costs one snapshot
// read per interval and only while a client is connected, and it is engine-independent by construction
// rather than by having a second branch that could rot. LISTEN/NOTIFY would be tighter and is the
// obvious later refinement; it is not what an unattended cutover should depend on.

export const REALTIME_PORT = 5051;

export interface Snapshot {
  at: string;
  status: StatusSnapshot;
  standupDoc: StandupDoc | null;
  lastStandupAt: string | null; // the since-last-standup boundary (088) — advanced only by "mark posted"
  spinoffs: SpinoffRow[];
  agents: AgentStatusRow[];
  whatsapp: WhatsappFeedItem[]; // read-only WhatsApp feed (102) — most-recent ingested messages
  whatsappStatus: StatusPerson[]; // current Status tray (629) — last 24h, others only; history is on-demand
  alertCount: number; // (#45) live count of un-acked alerts (computeAlerts − snoozed) — drives the header bell
  branchAgeMax: number; // (QW6) the stale-branch threshold in days (alert rule 3 — `branch_age_days` setting); drives the PR "stale" chip
  itemsStamp: string; // (OS-25) the item count and latest updated_at: moves on any item write (an `ob order`, a priority, an add or rm), so a page that lists items re-reads on a push
  decisionsStamp: string; // (OS-241) the decision count and newest id: moves when a decision is recorded (an `ob spinoff check`), which touches no item
}

/**
 * Whether two snapshots say the same thing (OB-1944). The top-level `at` is the read time, nowIso() on
 * every read, so it is left out; every other field, nested `at` values included, is compared, because a
 * nested `at` is real data (a message time) and a change in one is a change.
 */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  const { at: _a, ...restA } = a;
  const { at: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/** A snapshot of the surfaces (079's pure readers) from the store. Never advances any cursor.
 *  `fetchIssues` is the wayfinder-frontier seam (221) — injectable so tests never hit GitHub. */
export async function snapshotFrom(store: Store, fetchIssues?: IssueFetcher): Promise<Snapshot> {
  const status = await buildStatus(store, fetchIssues);
  const doc = await latestStandup(store);
  const whatsapp: WhatsappFeedItem[] = await latestPerChat(store, {
    limit: WHATSAPP_FEED_LIMIT,
  });
  const whatsappStatus = (await statusTray(store)).people;
  // (#45) The un-acked alert count rides the snapshot so the header bell updates live over the WS —
  // both computeAlerts + filterSnoozed are read-only.
  const alertCount = (
    await filterSnoozed(store, await computeAlerts(store, { focusProject: await getFocusProject(store) }))
  ).length;
  return {
    at: nowIso(),
    status,
    standupDoc: doc ? { ...doc, effective_md: effectiveText(doc) } : null, // the stored standup for the editable surface (088)
    lastStandupAt: await lastStandupAt(store),
    spinoffs: await listSpinoffs(store),
    agents: status.agents,
    whatsapp,
    whatsappStatus,
    alertCount,
    branchAgeMax: await settingNumFor(store, "branch_age_days"), // (QW6) same threshold alert rule 3 uses (default 3)
    itemsStamp: await itemsStamp(store),
    decisionsStamp: await decisionsStamp(store),
  };
}

// ── Sidecar HTTP helpers ─────────────────────────────────────────────────────────────────────────
// The WhatsApp media routes below share the ob-side Bun.serve with the realtime WS sidecar: CORS-open +
// LAN-only, with OPTIONS preflight handling. WS behaviour is untouched: the upgrade stays on its own path.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ── WhatsApp media + avatar + thread endpoints (158 voice notes + 162 images + 163 avatars + 168 thread + 629 status) ─
// Shares this ob-side Bun.serve (CORS-open/LAN posture). Routes:
//   GET  /api/whatsapp/media?chat_jid=&id=   → streams a message's image/audio/video bytes (for <img>/<audio>/<video>).
//   GET  /api/whatsapp/avatar?jid=           → streams a chat/group profile picture (163); 404 → initials.
//   POST /api/whatsapp/transcribe {chat_jid,id} → on-demand voice-note STT; stores + returns the transcript.
//   GET  /api/whatsapp/thread?chat_jid=&limit=&before= → a per-chat thread page (168); `before` pages
//        UPWARD (193), each request returning the next older batch + a `hasMore` flag, capped at 15/page.
//   GET  /api/whatsapp/status?limit=&before= → current Status tray, or a history page when `before` is set (629).
// The bridge bearer token NEVER reaches the browser — fetchWhatsappMedia/fetchWhatsappAvatar read it
// server-side and send it only to the loopback bridge. media + avatar + thread only READ (avatars are
// additionally disk-cached with a long TTL); transcribe writes the transcript. Non-whatsapp paths return null so the caller
// falls through. The thread is on-demand (keyed by chat_jid) so the WS snapshot never carries every
// chat's history — only the chat-list (latest-per-chat) rides the snapshot.

/** Hard cap on messages the thread endpoint returns per page — never load the whole history at once (168). */
export const WHATSAPP_THREAD_CAP = 15;
/** Default thread window when the caller omits `limit` (the UI opens with the last 5). */
const WHATSAPP_THREAD_DEFAULT = 5;
/** Hard cap on Status history items per page (629). */
export const WHATSAPP_STATUS_CAP = 30;
export const WHATSAPP_STATUS_DEFAULT = 20;

/**
 * Route an /api/whatsapp/* request. Returns a Response for a matched route, or null when the path is not
 * a whatsapp media route (so the caller falls through to the WS upgrade). Testable
 * directly (no socket): pass a `store`; in the server the sidecar passes its own.
 */
export async function handleWhatsappRequest(
  req: Request,
  opts: { store?: Store },
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/whatsapp/")) return null;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const isTranscribe = url.pathname === "/api/whatsapp/transcribe";
  // The whatsapp modules read and write through a Store (337), so this route needs nothing else.
  const store = opts.store ?? (await getStore());
  {
    if (url.pathname === "/api/whatsapp/media" && req.method === "GET") {
      const chatJid = url.searchParams.get("chat_jid");
      const id = url.searchParams.get("id");
      if (!chatJid || !id) return json({ error: "chat_jid and id query params are required" }, 400);
      try {
        const persist = await shouldPersistWhatsappMedia(store, chatJid, id);
        const media = await fetchWhatsappMedia(store, { chatJid, id, persist });
        return new Response(media.bytes as Uint8Array<ArrayBuffer>, {
          status: 200,
          headers: {
            "Content-Type": media.contentType,
            "Cache-Control": persist ? "private, max-age=86400" : "private, no-store",
            "Content-Disposition": `inline; filename="${media.filename}"`,
            ...CORS_HEADERS,
          },
        });
      } catch (e) {
        return json({ error: e instanceof AppError ? e.message : "media download failed" }, 404);
      }
    }

    if (url.pathname === "/api/whatsapp/avatar" && req.method === "GET") {
      const jid = url.searchParams.get("jid");
      if (!jid) return json({ error: "jid query param is required" }, 400);
      try {
        const avatar = await fetchWhatsappAvatar(store, { jid });
        if (!avatar) return json({ error: "no avatar" }, 404); // no picture → client shows initials
        return new Response(avatar.bytes as Uint8Array<ArrayBuffer>, {
          status: 200,
          headers: {
            "Content-Type": avatar.contentType,
            "Cache-Control": "private, max-age=86400",
            ...CORS_HEADERS,
          },
        });
      } catch (e) {
        return json({ error: e instanceof AppError ? e.message : "avatar fetch failed" }, 404);
      }
    }

    if (url.pathname === "/api/whatsapp/status" && req.method === "GET") {
      const raw = Number(url.searchParams.get("limit"));
      const limit =
        Number.isFinite(raw) && raw > 0 ? Math.min(raw, WHATSAPP_STATUS_CAP) : WHATSAPP_STATUS_DEFAULT;
      const before = url.searchParams.get("before") || undefined;
      const senderJid = url.searchParams.get("sender") || undefined;
      return json(
        before ? await statusHistoryPage(store, { limit, before, senderJid }) : await statusTray(store),
      );
    }

    if (url.pathname === "/api/whatsapp/thread" && req.method === "GET") {
      const chatJid = url.searchParams.get("chat_jid");
      if (!chatJid) return json({ error: "chat_jid query param is required" }, 400);
      const raw = Number(url.searchParams.get("limit"));
      // Clamp to [1, 15] server-side (168): a caller can never pull the whole PAGE at once.
      const limit =
        Number.isFinite(raw) && raw > 0 ? Math.min(raw, WHATSAPP_THREAD_CAP) : WHATSAPP_THREAD_DEFAULT;
      // 193: `before` cursor pages upward — each request returns the next older batch + a hasMore flag.
      const before = url.searchParams.get("before") || undefined;
      return json(await threadPageForChat(store, chatJid, { limit, before }));
    }

    if (isTranscribe && req.method === "POST") {
      let body: { chat_jid?: unknown; id?: unknown };
      try {
        body = (await req.json()) as { chat_jid?: unknown; id?: unknown };
      } catch {
        return json({ ok: false, error: "invalid JSON body" }, 400);
      }
      const chatJid = body.chat_jid;
      const id = body.id;
      if (typeof chatJid !== "string" || !chatJid || typeof id !== "string" || !id) {
        return json({ ok: false, error: "chat_jid and id are required" }, 400);
      }
      try {
        const result = await transcribeWhatsappMessage(store, { chatJid, id });
        return result.ok
          ? json({ ok: true, transcript: result.text })
          : json({ ok: false, reason: result.reason });
      } catch (e) {
        return json({ ok: false, error: e instanceof AppError ? e.message : "transcription failed" }, 400);
      }
    }

    return json({ error: "not found" }, 404);
  }
}

export interface RealtimeHandle {
  port: number;
  hostname: string;
  /** 220: whether this listener is serving wss:// rather than ws://. */
  tls: boolean;
  clientCount: () => number;
  /** Re-read the snapshot NOW and push it if it differs; resolves to whether it pushed (337). */
  poll: () => Promise<boolean>;
  stop: () => void;
}

/**
 * How often the sidecar re-reads while a client is connected (337).
 *
 * Two seconds, and the number is a judgement rather than a measurement: the surface it feeds is a
 * personal dashboard on a second screen, where "within a couple of seconds" is indistinguishable from
 * instant, and the read is skipped entirely when nobody is looking. The file-watch it replaces pushed
 * within ~250ms of a write; that latency was free because the trigger was the write itself, and it is
 * not worth buying back with a poll five times as often.
 */
export const REALTIME_POLL_MS = 2000;

/** PEM material for the sidecar's listener (220). Resolved by web-tls.ts; this module only serves it. */
export interface RealtimeTls {
  cert: string;
  key: string;
}

/**
 * Where the realtime WebSocket lives when the sidecar is mounted under the dashboard's OWN origin
 * (358). The standalone listener upgrades on `GET /` and keeps doing so; a mounted one cannot, because
 * `/` on that origin is the dashboard page itself, so the socket needs a path of its own.
 *
 * This is a PATH and not a port on purpose. The page used to dial `<its own hostname>:5051`, which is
 * right on the LAN and unreachable through the Cloudflare tunnel (354) -- Cloudflare's proxy carries a
 * fixed set of ports and 5051 is not among them, so every sidecar request through the tunnel returned
 * 503 or hung: no WhatsApp thread, no avatars, no media, and a realtime socket that never connected so
 * the header read "offline". A same-origin path has no port to be wrong about, and `wss` upgrades on
 * the page's own host and port without any extra hostname or Access policy.
 */
export const REALTIME_WS_PATH = "/api/realtime";

/** The sidecar's HTTP route prefixes, for callers that must decide BEFORE reading a body. */
const SIDECAR_PREFIXES = ["/api/whatsapp/", REALTIME_WS_PATH] as const;

/**
 * Whether a path belongs to the sidecar rather than to the dashboard's static layer or its router.
 * `apps/dashboard/serve.ts` asks this first, the same way it asks `isObApiPath` (352): a sidecar path
 * must never fall through to the router's notFound, which would answer with an HTML 404.
 */
export function isSidecarPath(pathname: string): boolean {
  return SIDECAR_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
}

/** A sidecar that some other `Bun.serve` hosts: its fetch branch, its websocket handlers, its poll. */
export interface SidecarMount {
  /** Answer a sidecar request, or return null when the path is not the sidecar's. */
  fetch: (req: Request, upgrade: (req: Request) => boolean) => Promise<Response | null | undefined>;
  websocket: {
    open: (ws: ServerWebSocket<unknown>) => void;
    close: (ws: ServerWebSocket<unknown>) => void;
    message: () => void;
  };
  clientCount: () => number;
  poll: () => Promise<boolean>;
  stop: () => void;
}

/**
 * The sidecar's behaviour, with no listener of its own (358). `startRealtimeServer` wraps this in a
 * `Bun.serve` on 5051; `apps/dashboard/serve.ts` mounts the same object into the dashboard's server so
 * the browser reaches these routes on the page's own origin. One implementation either way -- the two
 * mountings differ only in where the socket upgrades.
 */
export function createSidecar(
  opts: {
    /**
     * The store every route and every push reads through (337). Optional so a test can start a sidecar
     * without one; absent, the per-process store is resolved on first use, which is the configured
     * engine rather than a file this module picked for itself. A thunk (OB-1617) lets a host hand its
     * own singleton through, opened with the options it chose (the dashboard's `migrate: false`).
     */
    store?: Store | (() => Promise<Store>);
    debounceMs?: number;
    /** How often the snapshot is re-read while a client is connected (337). */
    pollMs?: number;
    /** Whether `GET /` upgrades to a socket. True for the standalone listener, false when mounted. */
    upgradeOnRoot?: boolean;
  } = {},
): SidecarMount {
  const storeFor = async (): Promise<Store> =>
    typeof opts.store === "function" ? opts.store() : (opts.store ?? (await getStore()));
  const pollMs = opts.pollMs ?? opts.debounceMs ?? REALTIME_POLL_MS;
  const upgradeOnRoot = opts.upgradeOnRoot ?? true;
  const clients = new Set<ServerWebSocket<unknown>>();
  // The last snapshot a BROADCAST pushed, so an unchanged database costs one read and no traffic. It is
  // the shared baseline every connected client is assumed to have caught up to, so only a broadcast
  // moves it (OB-1944). A connect that moved it would hide the change it just read from every client
  // that was already there.
  let lastPushed: Snapshot | null = null;

  // OB-1944: reads run one at a time. An interval tick, `poll()` and a connect each start a read, and a
  // slow read that began first could otherwise finish last and push an older snapshot after a newer one.
  // `tail` is the end of the queue, or null when nothing is running.
  let tail: Promise<void> | null = null;
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = (tail ?? Promise.resolve()).then(fn);
    const mine: Promise<void> = run
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        if (tail === mine) tail = null;
      });
    tail = mine;
    return run;
  };

  const read = async (): Promise<Snapshot> => snapshotFrom(await storeFor());

  const send = (ws: ServerWebSocket<unknown>) =>
    enqueue(async () => {
      const data = await read();
      // The new client gets its own fresh snapshot. The shared baseline is seeded only when there is
      // none (the first client after idle), so an idle dashboard stays quiet; otherwise it is left alone
      // and the next broadcast may resend this snapshot to the new client, which is harmless.
      if (lastPushed === null) lastPushed = data;
      ws.send(JSON.stringify({ type: "snapshot", data }));
    });
  /** Re-read and push, but only when something actually moved. Returns whether it pushed. */
  const broadcast = (): Promise<boolean> =>
    enqueue(async () => {
      if (clients.size === 0) return false;
      const data = await read();
      if (lastPushed !== null && sameSnapshot(data, lastPushed)) return false;
      lastPushed = data;
      const msg = JSON.stringify({ type: "snapshot", data });
      for (const ws of clients) ws.send(msg);
      return true;
    });

  // A read that throws (the database briefly unreachable mid-migration, say) must not kill the poll:
  // the sidecar is supervised as a KeepAlive job, so a thrown timer callback would take the dashboard
  // down with it for a transient the next tick would have survived.
  // A tick that finds a read still running is skipped: the running one is already fetching fresher state.
  const timer = setInterval(() => {
    if (tail === null) void broadcast().catch(() => {});
  }, pollMs);
  // Nothing here should hold the process open on its own account: `ob web` exits when its child does.
  timer.unref?.();

  return {
    async fetch(req, upgrade) {
      const path = new URL(req.url).pathname;
      // The socket first: it is matched by path, so a mounted sidecar upgrades on REALTIME_WS_PATH and
      // the standalone one still upgrades on `/` for anything already dialling 5051 directly.
      if (path === REALTIME_WS_PATH || (upgradeOnRoot && path === "/")) {
        if (upgrade(req)) return undefined; // 101 switching protocols
        return new Response("omnislash realtime\n");
      }
      // WhatsApp media (158/162) HTTP endpoints.
      const whatsapp = await handleWhatsappRequest(req, { store: await storeFor() });
      if (whatsapp) return whatsapp;
      return null;
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        void send(ws).catch(() => {}); // initial state — the client renders from its SSR snapshot, then live-patches
      },
      close(ws) {
        clients.delete(ws);
        // Nobody left to have caught up: the next first client seeds a fresh baseline.
        if (clients.size === 0) lastPushed = null;
      },
      message() {}, // read-only: clients don't send commands (yet)
    },
    clientCount: () => clients.size,
    /** Re-read now rather than at the next tick. The seam a test drives instead of sleeping. */
    poll: () => broadcast(),
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Start the WS sidecar on its own port: pushes the current snapshot on connect, then re-reads on an
 * interval and re-pushes only when the payload actually differs (337 -- see the change-detection note).
 *
 * `hostname` is the bind address (192). Bun.serve with no hostname listens on every interface, so the
 * default here is loopback and a wider bind is always the caller passing one.
 *
 * `tls` (220) is the SAME material the dashboard serves. The page derives its socket URL from its own
 * origin (realtimeUrl.ts), so an https page dials wss and a sidecar still on ws is a page that loads
 * and then never live-updates. One deployment, one scheme.
 *
 * 358: this listener is NO LONGER what the dashboard page talks to -- the page reaches the same routes
 * on its own origin under `/api/whatsapp/` and REALTIME_WS_PATH. It stays for clients that dial the
 * sidecar's own port directly.
 */
export function startRealtimeServer(
  opts: {
    port?: number;
    hostname?: string;
    store?: Store;
    debounceMs?: number;
    pollMs?: number;
    tls?: RealtimeTls | null;
  } = {},
): RealtimeHandle {
  const port = opts.port ?? REALTIME_PORT;
  const hostname = opts.hostname?.trim() || WEB_BIND_DEFAULT;
  const tls = opts.tls ?? null;
  const sidecar = createSidecar({
    store: opts.store,
    debounceMs: opts.debounceMs,
    pollMs: opts.pollMs,
    upgradeOnRoot: true,
  });

  const server = Bun.serve({
    port,
    hostname,
    ...(tls ? { tls: { cert: tls.cert, key: tls.key } } : {}),
    async fetch(req, srv) {
      const res = await sidecar.fetch(req, (r) => srv.upgrade(r, { data: undefined }));
      if (res !== null) return res;
      return new Response("omnislash realtime\n");
    },
    websocket: sidecar.websocket,
  });

  return {
    port: server.port ?? port,
    hostname,
    tls: tls !== null,
    clientCount: sidecar.clientCount,
    poll: sidecar.poll,
    stop() {
      sidecar.stop();
      // Bun.serve.stop returns a Promise; this handle is sync (signal-handler callers cannot await).
      void server.stop(true);
    },
  };
}

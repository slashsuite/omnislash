import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "./types.ts";
import { realtimeWsUrl } from "./realtimeUrl.ts";

// Client subscription to the realtime WS sidecar (083). The view renders from its SSR loader
// snapshot, then live-patches from these pushes. Auto-reconnects. Client-only (guarded by useEffect).
//
// `adopt` lets a WRITE path apply the snapshot its own server fn already returned (#120: sending a WhatsApp
// reply), so the view reflects the write immediately instead of waiting for the next WS push. It is the same
// state a push writes, so a later push simply supersedes it. Each caller of this hook owns its own
// subscription + state, so adopting affects only the view that sent.

export { REALTIME_WS_PATH } from "./realtimeUrl.ts";

/** Reconnect delay (OB-1944): 1 s, doubling each failed attempt, capped at 30 s. No jitter: one user. */
function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/**
 * The snapshot to hold after `next` arrives (OB-1944). A snapshot read BEFORE the one already held is
 * dropped, so a push that was read before a write and delivered after `adopt(next)` cannot put the old
 * state back. Order is by `at` (set on every snapshot, pushed or returned by a server fn, from the same
 * clock); ties are accepted.
 */
function newerSnapshot(held: Snapshot | null, next: Snapshot): Snapshot {
  if (!held) return next;
  const h = Date.parse(held.at);
  const n = Date.parse(next.at);
  return Number.isFinite(h) && Number.isFinite(n) && n < h ? held : next;
}

export function useRealtime(): {
  snap: Snapshot | null;
  connected: boolean;
  adopt: (next: Snapshot) => void;
} {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(realtimeWsUrl(location));
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, retryDelayMs(attempt++)); // reconnect/backfill
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === "snapshot") setSnap((held) => newerSnapshot(held, msg.data as Snapshot));
        } catch {
          /* ignore malformed frames */
        }
      };
    };

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const adopt = useCallback((next: Snapshot) => setSnap((held) => newerSnapshot(held, next)), []);
  return { snap, connected, adopt };
}

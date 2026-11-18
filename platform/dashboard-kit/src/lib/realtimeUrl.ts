// Where the browser reaches the ob-side sidecar (the realtime WS + the WhatsApp media/avatar/thread
// proxies). SAME ORIGIN AS THE PAGE, under a path (358).
//
// It used to be the page's own hostname plus a hardcoded port 5051. That is correct on the LAN
// (a page on http://<lan-ip>:5050 dials <lan-ip>:5051) and dead behind the Cloudflare tunnel
// (354): Cloudflare's proxy carries a fixed set of ports and 5051 is not among them, so through the
// tunnel every one of these requests returned 503 or hung. One fault, four symptoms -- the WhatsApp
// thread never loaded, avatars were blank, media never arrived, and the realtime socket never
// connected so the header read "offline".
//
// So nothing here builds a port any more. The HTTP proxies are reached by a ROOT-RELATIVE path, which
// is same-origin by construction and cannot carry a port at all. The socket needs a scheme swap, so it
// is the one absolute URL, and it takes the page's own `host` verbatim -- port included when the page
// itself has one (the LAN's :5050), absent when it does not (the tunnel's 443). That keeps the LAN and
// the tunnel on one code path instead of two.

/** The sidecar's WebSocket path on the page's own origin. Must match REALTIME_WS_PATH in apps/cli. */
export const REALTIME_WS_PATH = "/api/realtime";

export interface OriginLike {
  protocol: string;
  /** host = hostname plus `:port` when the page has a non-default one. Never a port of our choosing. */
  host: string;
}

/** The WS URL for the realtime sidecar; wss when the page itself is https, on the page's own host. */
export function realtimeWsUrl(loc: OriginLike): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${REALTIME_WS_PATH}`;
}

/**
 * The base the sidecar's HTTP proxy endpoints hang off. Empty, deliberately: callers build
 * `${sidecarBaseUrl()}/api/whatsapp/media?...`, which is a root-relative same-origin URL with no
 * scheme, no host and no port for a deployment to get wrong.
 */
export function sidecarBaseUrl(): string {
  return "";
}

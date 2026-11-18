// OB service worker (OB-2205, copied from apps/dashboard/public/sw.js, ob 1693): lets the OB dashboard install to the Home Screen, and shows an offline notice.
//
// What it caches, and what it deliberately does not:
//  - PRECACHE: the offline page and the static files it and the manifest need. Nothing else is stored up front.
//  - /assets/*: Vite's content-hashed JS/CSS, cache-first. A hashed file never changes, so a hit is always right.
//  - NOTHING ELSE. Pages are server-rendered with live data, and every server function and API answer is live
//    too (money, WhatsApp, journal), so none of it is ever written to a cache: a stale financial or
//    WhatsApp view is worse than an offline notice. A page navigation goes to the network, and only when that
//    fails does it get /offline.html. API, server-function and every other request pass straight through.
//
// The VERSION below is a placeholder that serve.ts replaces as it serves this file (sw-version.ts) with a
// hash of the built files. A deploy that changes the app therefore changes this file, the browser installs the
// new worker, and the activate step deletes the old cache. skipWaiting + clients.claim make the new worker
// take over at once; the page (src/lib/registerSw.ts) sees the controller change and offers a reload.
const VERSION = "__SW_VERSION__";
const CACHE_PREFIX = "ob-shell-";
const CACHE = CACHE_PREFIX + VERSION;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/favicon.svg",
  "/omnislash-logo-light.svg",
];
// Never touched by this worker, even for a navigation: the ob API, the realtime/journal/WhatsApp sidecar
// routes under /api/, and TanStack Start's server functions.
const LIVE_PREFIXES = ["/api/", "/_serverFn/"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (LIVE_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  if (url.pathname.startsWith("/assets/") || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok && url.pathname.startsWith("/assets/")) await cache.put(request, res.clone());
        return res;
      }),
    );
  }
});

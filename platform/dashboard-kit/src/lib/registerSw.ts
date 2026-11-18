// ob 1693: register /sw.js and tell the page when a newer worker has taken over. A service worker only
// registers over HTTPS or localhost, so on plain http (the dashboard's old LAN address) this is a no-op.
// Dev (`vite dev`) never registers: the worker would cache the dev server's modules.
export function registerServiceWorker(onUpdate: () => void): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  // A first install also fires `controllerchange` (clients.claim); only a change from an existing
  // controller is an update worth interrupting for.
  const hadController = container.controller !== null;
  container.addEventListener("controllerchange", () => {
    if (hadController) onUpdate();
  });
  // `updateViaCache: none` so the browser always asks the server for a fresh sw.js, whatever its headers.
  void container.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((error) => console.warn("service worker registration failed", error));
}

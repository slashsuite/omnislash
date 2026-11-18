// The document-head tags that make the OB dashboard installable from the iPhone/iPad Home Screen, as
// apps/dashboard/src/lib/pwa.ts does for the personal one. The title differs ("OB"), and the manifest's own
// `id` (/ob) is what keeps the two as separate Home Screen apps. Kept apart from the root route so a test can
// read them without loading the stylesheet import.
export const PWA_THEME_COLOR = "#181825";

export const VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover";

export const PWA_META = [
  { name: "theme-color", content: PWA_THEME_COLOR },
  { name: "mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-status-bar-style", content: "default" },
  { name: "apple-mobile-web-app-title", content: "OB" },
];

export const PWA_LINKS = [
  // `use-credentials`: a manifest is fetched without cookies by default, so a gate in front of the page would
  // answer it with a login redirect.
  { rel: "manifest", href: "/manifest.webmanifest", crossOrigin: "use-credentials" as const },
  { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
];

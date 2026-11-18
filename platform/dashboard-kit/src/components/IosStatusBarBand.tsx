// ob 1708: iPadOS 26 keeps a scroll-edge blur under the status bar of a Home Screen web app and fills it with a
// solid colour only when WebKit finds a FIXED element at the top edge (LocalFrameView::fixedContainerEdges: hit-test
// 4px below the middle of the top edge; the element spans >= 90% of the viewport width and is taller than 10px).
// This is that element: 12px, full width, the header's own background (`bg-white`, which the theme maps to the
// same base colour the header paints) for WebKit to read, and `bg-clip-text` so with no text it paints nothing.
// Shown only when installed (`display-mode: standalone`), so a normal tab is pixel-identical. It is rendered by the
// root document, not a client effect, so it exists from the first frame (iPadOS keeps the blur after a frame without it).
const CLASS = [
  "fixed inset-x-0 top-0 h-3 z-[2147483647] pointer-events-none",
  "bg-white bg-clip-text",
  "hidden [@media(display-mode:standalone)]:block",
].join(" ");

export function IosStatusBarBand() {
  return <div aria-hidden="true" data-ios-status-bar-band className={CLASS} />;
}

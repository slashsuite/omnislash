import type { QrState } from "../../../../platform/cli-whatsapp/src/whatsapp/qr.ts";

// 274: the pairing panel's view model. Pairing WhatsApp used to mean tailing the bridge log for an ASCII
// QR that rotates every ~20 seconds, on a terminal on the box. This page shows it instead — and the thing
// worth being careful about is that a QR is only useful if the reader can trust its freshness, so the
// panel never renders an image without saying, in the same breath, how old it is and whether the phone
// will still take it.
//
// The RAW PAYLOAD never reaches the browser. The server renders the image and strips the code, so what
// crosses the wire is a PNG plus a sentence. That matters: whoever scans a live QR links a device to the
// account, and the dashboard is on the house LAN.

export type { QrState };

/** What the server sends the pairing panel. Deliberately has no `code` field: only the rendered image. */
export interface WhatsappQrView {
  state: QrState;
  /** The QR as a PNG data URL for a plain `<img src>`, or null when there is nothing scannable. */
  image: string | null;
  emitted_at: string | null;
  age_s: number | null;
  /** What was read, and what it does not prove. Never contains the payload. */
  detail: string;
  /** The file holds a pairing secret; true when it is readable by more than its owner. */
  insecure_mode: boolean;
  path: string;
}

export type QrTone = "neutral" | "warn" | "positive" | "info" | "danger";

export interface QrPanel {
  /** Whether the panel belongs on the page at all. */
  show: boolean;
  headline: string;
  tone: QrTone;
  /** Whether the rendered image should be shown. False for a code the phone would refuse. */
  showImage: boolean;
  /**
   * Poll interval in ms, or null to stop polling. Null only when there is nothing left to watch for
   * (the panel is hidden because the session is linked); a panel that has not been read yet keeps looking.
   */
  pollMs: number | null;
  /**
   * Whether to offer the "Start pairing" button. The panel was display-only at first and that made it
   * useless for its own purpose: with no QR file there was nothing on the page to click, and the only way
   * to cause one was a terminal command. The button is offered when there is no live code to scan AND the
   * session is not linked; the server refuses it anyway when the bridge is healthy, so this is the polite
   * half of the guard, not the real one.
   */
  showStart: boolean;
  /**
   * A sentence to render INSTEAD of `qr.detail`, or null to use the file's own.
   *
   * The reader cannot always tell the truth on its own: with no QR file it has to offer both
   * explanations ("either the session is linked, or the bridge predates the patch"), and on an unlinked
   * machine the first half is simply false — which put a card headed "Not linked" directly above a
   * sentence saying it probably was. The panel knows which case it is in, so it says so.
   */
  detail: string | null;
}

/**
 * Poll faster than the ~20s rotation, not on it. Landing exactly on the boundary is how you show a code
 * that expired between the read and the scan, so a live panel re-reads every 5s — a local file read, on
 * the same box, costing nothing.
 */
export const QR_POLL_LIVE_MS = 5_000;

/**
 * Keep looking, slowly, when there is nothing to show. A QR appears the moment the bridge restarts
 * unpaired, and a page that had to be reloaded to notice would be a page nobody trusts to be current.
 */
export const QR_POLL_IDLE_MS = 20_000;

/**
 * How the panel reads.
 *
 * `unset` (no QR file) is the state that decides whether this page is usable at all, and it depends on
 * something the QR file cannot know: whether the session is LINKED. Linked and no file is the healthy
 * steady state, and a permanent "no QR" card there is the kind of row that teaches a reader to ignore
 * this page, so it hides. NOT linked and no file is the case that sent the owner looking for a button
 * that was not there, so it shows, and it offers one.
 *
 * `paired` is shown, briefly and green, because it is the answer to the question the reader just asked.
 *
 * @param linked whether ob can see a stored WhatsApp pairing (the `whatsapp` credential row's presence).
 */
export function qrPanel(qr: WhatsappQrView | null, opts: { linked?: boolean } = {}): QrPanel {
  const linked = opts.linked ?? true;
  const hidden: QrPanel = {
    show: false,
    headline: "",
    tone: "neutral",
    showImage: false,
    // OB-1942: a hidden panel is the healthy steady state, and reading a pairing secret off disk every
    // 20s to confirm nothing changed is a timer nobody is watching for. When there is nothing to look
    // for, stop.
    pollMs: null,
    showStart: false,
    detail: null,
  };
  // Nothing has been read yet: the first read is still to come, so keep looking for it.
  if (!qr) return { ...hidden, pollMs: QR_POLL_IDLE_MS };
  switch (qr.state) {
    case "unset":
      if (linked) return hidden;
      return {
        show: true,
        headline: "Not linked, and no pairing QR yet",
        tone: "warn",
        showImage: false,
        pollMs: QR_POLL_IDLE_MS,
        showStart: true,
        detail:
          "ob can see no stored WhatsApp pairing, and the bridge has not written a QR. It only emits one" +
          " when it starts with no usable session, so start it below and the code will appear here.",
      };
    case "live":
      return {
        show: true,
        headline: `Scan this now — emitted ${qr.age_s ?? 0}s ago`,
        tone: "positive",
        showImage: true,
        pollMs: QR_POLL_LIVE_MS,
        // No button beside a live code: the thing to do is scan it, and a button that restarts the bridge
        // would throw away the very QR on screen.
        showStart: false,
        detail: null,
      };
    case "expired":
      return {
        show: true,
        headline: "This code has expired",
        tone: "warn",
        // Shown anyway, greyed by the caller: the bridge may be one rotation behind rather than stopped,
        // and hiding it would leave a card that says "expired" beside nothing at all.
        showImage: true,
        pollMs: QR_POLL_LIVE_MS,
        showStart: !linked,
        detail: null,
      };
    case "paired":
      return {
        show: true,
        headline: "Paired — the bridge recorded a successful scan",
        tone: "positive",
        showImage: false,
        pollMs: QR_POLL_IDLE_MS,
        // OB-1942: `paired` is the last thing the bridge WROTE, not proof the session is still linked —
        // it stays there after a logout, and the bridge never reports one. The credential row is the only
        // liveness signal, so when it says not linked, the honest offer is to start again.
        showStart: !linked,
        detail: null,
      };
    case "timeout":
      return {
        show: true,
        headline: "The pairing window closed unscanned",
        tone: "danger",
        showImage: false,
        pollMs: QR_POLL_IDLE_MS,
        // This is the state the button exists for: the window only reopens on a bridge start.
        showStart: !linked,
        detail: null,
      };
    case "unreadable":
      return {
        show: true,
        headline: "The QR file could not be read",
        tone: "danger",
        showImage: false,
        pollMs: QR_POLL_IDLE_MS,
        // Deliberately no button: the file is the one thing that is broken, so starting a bridge would
        // add a second unknown on top of an unread one.
        showStart: false,
        detail: null,
      };
  }
}

export const QR_EXPOSURE_NOTICE =
  "Anyone who scans a live code here links their WhatsApp to this account, so treat this panel like the phone screen it replaces: it is only ever on screen while the bridge is actually waiting to be paired.";

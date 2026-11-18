import QRCode from "qrcode";
import type { WhatsappQr } from "../../../../platform/cli-whatsapp/src/whatsapp/qr.ts";
import type { WhatsappQrView } from "../lib/whatsappQr.ts";

// 274: the one place the pairing payload is turned into something a browser may see.
//
// Server-only on purpose, and its own module so it can be tested without a request context. The whole
// job is a boundary: a `WhatsappQr` carries the raw pairing code, a `WhatsappQrView` carries a PNG and
// never has a `code` field at all, and this function is what stands between them. Whoever scans a live
// code links a device to the account, so the code goes no further than this call — not into the payload,
// not into a log line, and not into the message of a render error.

/** Strip the payload and hand back the image. The only export; there is no path that returns the code. */
export async function renderWhatsappQr(read: WhatsappQr): Promise<WhatsappQrView> {
  const { code, ...view } = read;
  if (!code) return { ...view, image: null };
  try {
    // A PNG data URL rather than an SVG document, so the page renders a plain <img src> and never injects
    // generated markup into the DOM. Error-correction L is what whatsmeow's own terminal renderer uses; a
    // higher level would only add modules for a phone camera to resolve, at no benefit for a code that is
    // replaced every ~20 seconds anyway.
    const image = await QRCode.toDataURL(code, { errorCorrectionLevel: "L", margin: 1, width: 320 });
    return { ...view, image };
  } catch (err) {
    // `err` is quoted, `code` never is: a render failure must not become the leak.
    return { ...view, image: null, state: "unreadable", detail: `the QR could not be rendered: ${(err as Error).message}` };
  }
}

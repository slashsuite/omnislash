/**
 * Same-origin guard for the dashboards' POST server fns (OB-1908, moved into the kit by OB-2204).
 *
 * Server fns are POST endpoints. A page on another site open in the same browser could POST to them, so
 * the guarded ones call this first and do nothing when it refuses: the WhatsApp sends
 * (`sendWhatsappReply`, `sendFamilyUpdate`, in the personal dashboard) and every ob write in `writes.ts`. A server cannot prove a click was human; this only proves the request came from
 * our own page.
 *
 * Rule: `Sec-Fetch-Site` decides when the browser sends it (`same-origin` passes; `same-site`,
 * `cross-site` and `none` refuse). When it is absent, the `Origin` host must equal the request URL's
 * host. With neither, refuse.
 */

/** The named error a refused send throws, so a caller (and a test) can tell it from any other failure. */
export class CrossSiteRequestError extends Error {
  constructor(message = "Refused: this request did not come from the dashboard's own origin.") {
    super(message);
    this.name = "CrossSiteRequestError";
  }
}

/** True only for a request that came from the dashboard's own origin. */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false; // an unparsable Origin ("null") is not ours
  }
}

/** Throws `CrossSiteRequestError` unless the request is same-origin. */
export function assertSameOrigin(request: Request): void {
  if (!isSameOrigin(request)) throw new CrossSiteRequestError();
}

// What an error report may carry (ob 1657). One `beforeSend` for both daemons that report to Sentry
// (omnislash-web and the WhatsApp bridge supervisor). It keeps the message, the stack, the release and the
// environment, and drops everything that could hold a person's data: request bodies, cookies, the query
// string, auth and Cloudflare Access headers, the user, breadcrumbs, `extra`, and any token, phone number
// or WhatsApp id that found its way into a string. It is a deny-by-default walk of the whole event, so a
// field the SDK adds later is scrubbed too.
//
// Same shape as pixelslash's `sentry-scrub.ts` (PS-227), plus the WhatsApp half: a phone number or a JID
// in an error string, and any key that carries message content. Pure and dependency-free.

const REDACTED = "[redacted]";

/** Request headers worth keeping; every other header is dropped, not matched against a deny list. */
const KEEP_HEADERS = new Set(["user-agent", "content-type", "content-length", "accept", "host"]);

/** A key whose value is never sent, whatever it holds. */
const SECRET_KEY =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|signature|session|dsn|bearer|jwt|cf-access|access[-_]?(?:id|key)|^sig$|^body$|^content$|caption|^text$|phone|msisdn|jid|sender|recipient|whatsapp|message[-_]?(?:body|text|content)/i;

/** Fields the SDK sets that are never private and that the string walk would only mangle (a sha is digits). */
const KEEP_TOP_LEVEL = ["release", "environment", "event_id", "timestamp", "platform", "level", "type"];

/** A WhatsApp id: a number (optionally with a device suffix) at a WhatsApp server. */
const JID = /\b\d+(?::\d+)?@(?:s\.whatsapp\.net|c\.us|g\.us|lid|broadcast)\b/gi;
/** An international number written with a plus, separators allowed. */
const PLUS_PHONE = /\+\d[\d\s().-]{6,}\d/g;
/** A bare run of 9 to 15 digits (an MSISDN without its plus, or a local number). */
const BARE_PHONE = /(?<![\w.])\d{9,15}(?![\w])/g;
/** The tokens this setup issues or accepts, plus any `Bearer` value. */
const TOKEN = /\b(?:sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[bapors]-)[A-Za-z0-9_-]{6,}|\bBearer\s+\S+/g;
/** A secret in a URL: a signed link's `sig`, an OAuth `code`, an access token. */
const URL_SECRET = /([?&](?:sig|signature|token|access_token|code|state|key|secret)=)[^&\s"'#]*/gi;
/** A run of base64 too long to be anything but a blob. */
const BLOB_RUN = /[A-Za-z0-9+/_-]{200,}={0,2}/g;
/** A Sentry DSN, in case one is pasted into an error message. */
const DSN = /https?:\/\/[0-9a-f]+(?::[^@\s]*)?@[^/\s]*sentry[^/\s]*\/\d+/gi;

function scrubString(value: string): string {
  return value
    .replace(JID, "[jid]")
    .replace(DSN, REDACTED)
    .replace(TOKEN, REDACTED)
    .replace(URL_SECRET, `$1${REDACTED}`)
    .replace(PLUS_PHONE, "[phone]")
    .replace(BARE_PHONE, "[phone]")
    .replace(BLOB_RUN, "[blob data]");
}

function isBinary(value: object): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (isBinary(value)) return "[binary data]";
  if (depth > 12) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : scrubValue(inner, depth + 1);
  }
  return out;
}

/** The URL without its query string or fragment: `?sig=…` and `?code=…` are secrets. */
function bareUrl(url: unknown): unknown {
  if (typeof url !== "string") return url;
  return scrubString(url.replace(/[?#].*$/, ""));
}

function scrubRequest(request: unknown): unknown {
  if (request === null || typeof request !== "object") return request;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key === "url") kept["url"] = bareUrl(value);
    else if (key === "method") kept["method"] = value;
    else if (key === "headers" && value !== null && typeof value === "object") {
      kept["headers"] = Object.fromEntries(
        Object.entries(value).filter(([name]) => KEEP_HEADERS.has(name.toLowerCase())),
      );
    }
    // `data` (the body), `cookies`, `query_string` and `env` are dropped, not scrubbed.
  }
  return kept;
}

/**
 * The event as it may leave the machine. Use as `beforeSend`. Scrubs the event in place and never
 * returns null: an error is still worth reporting once what is private about it is gone.
 */
export function scrubEvent<T extends object>(event: T): T {
  const keep = KEEP_TOP_LEVEL.map((key) => [key, Reflect.get(event, key)] as const);
  const scrubbed = scrubValue(event, 0);
  if (scrubbed === null || typeof scrubbed !== "object") return event;
  for (const key of Object.keys(event)) {
    if (key === "breadcrumbs" || key === "user" || key === "extra") Reflect.deleteProperty(event, key);
    else Reflect.set(event, key, Reflect.get(scrubbed, key));
  }
  // `request` goes through its own allowlist before the walk's: headers are kept by name, not by luck.
  const request = Reflect.get(event, "request");
  if (request !== undefined) Reflect.set(event, "request", scrubRequest(request));
  for (const [key, value] of keep) if (value !== undefined) Reflect.set(event, key, value);
  return event;
}

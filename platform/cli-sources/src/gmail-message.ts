import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import { header } from "./ingest/gmail.ts";
import type { GmailDraftClient, GmailMessagePart } from "./google.ts";

// -----------------------------------------------------------------------------
// 1680: read one Gmail message and pull its attachments. Both are READ-ONLY (gmail.modify already covers
// them); nothing here labels, trashes or sends. The pure helpers take the Gmail API payload, so a fixture
// is all a test needs.
// -----------------------------------------------------------------------------

export interface GmailAttachmentInfo {
  filename: string;
  mime: string;
  size: number;
  /** Gmail's id for `messages.attachments.get`; null when the bytes ride inline in the part body. */
  attachment_id: string | null;
}

export interface GmailMessageRead {
  id: string;
  thread_id: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string;
  date: string | null;
  body: string;
  attachments: GmailAttachmentInfo[];
}

/** One attachment with its bytes, as the API host hands it to a client (the CLI writes the file). */
export interface GmailAttachmentFile {
  filename: string;
  mime: string;
  size: number;
  data_base64: string;
}

export interface GmailAttachmentsResult {
  message_id: string;
  attachments: GmailAttachmentFile[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Text/html to readable text: drop script/style, turn block tags into line breaks, decode entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeData(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** A part that is a file (has a filename), as opposed to a text body part of the message. */
function isFilePart(p: GmailMessagePart): boolean {
  return !!p.filename && !p.mimeType?.startsWith("multipart/");
}

/** The message text: the first text/plain body part, else the first text/html one stripped to text. */
export function messageText(payload: GmailMessagePart | undefined): string {
  if (!payload) return "";
  const walk = (part: GmailMessagePart, want: string): string | null => {
    if (part.mimeType === want && !isFilePart(part) && part.body?.data) return decodeData(part.body.data);
    for (const sub of part.parts ?? []) {
      const hit = walk(sub, want);
      if (hit) return hit;
    }
    return null;
  };
  const plain = walk(payload, "text/plain");
  if (plain) return plain.trim();
  const html = walk(payload, "text/html");
  if (html) return htmlToText(html);
  return payload.parts ? "" : decodeData(payload.body?.data).trim();
}

export interface FilePart {
  info: GmailAttachmentInfo;
  /** base64url bytes when the part carries them inline instead of behind an attachment id. */
  inline?: string | undefined;
}

/** Every file part of a message, in document order. */
export function fileParts(payload: GmailMessagePart | undefined): FilePart[] {
  const out: FilePart[] = [];
  const walk = (part: GmailMessagePart): void => {
    if (isFilePart(part) && (part.body?.attachmentId || part.body?.data)) {
      out.push({
        info: {
          filename: part.filename!,
          mime: part.mimeType ?? "application/octet-stream",
          size: part.body?.size ?? 0,
          attachment_id: part.body?.attachmentId ?? null,
        },
        inline: part.body?.attachmentId ? undefined : part.body?.data,
      });
    }
    for (const sub of part.parts ?? []) walk(sub);
  };
  if (payload) walk(payload);
  return out;
}

export function listAttachments(payload: GmailMessagePart | undefined): GmailAttachmentInfo[] {
  return fileParts(payload).map((f) => f.info);
}

/** `gmail read <id>`: headers, text body and the attachment list. Never modifies the message. */
export async function readGmailMessage(client: GmailDraftClient, id: string): Promise<GmailMessageRead> {
  const msg = await client.gmailGetMessage(id);
  return {
    id: msg.id,
    thread_id: msg.threadId ?? null,
    from: header(msg.payload, "From"),
    to: header(msg.payload, "To"),
    cc: header(msg.payload, "Cc"),
    subject: header(msg.payload, "Subject") ?? "",
    date: header(msg.payload, "Date"),
    body: messageText(msg.payload),
    attachments: listAttachments(msg.payload),
  };
}

/**
 * The bytes of a message's attachments: all of them, or the one called `name` exactly. An unknown `name`
 * is a usage error that lists the real ones.
 */
export async function fetchGmailAttachments(
  client: GmailDraftClient,
  id: string,
  name?: string,
): Promise<GmailAttachmentsResult> {
  const msg = await client.gmailGetMessage(id);
  const files = fileParts(msg.payload);

  if (files.length === 0) throw new UsageError(`message ${id} has no attachments`);
  const picked = name == null ? files : files.filter((f) => f.info.filename === name);
  if (picked.length === 0) {
    throw new UsageError(
      `message ${id} has no attachment named '${name}' (it has: ${files.map((f) => f.info.filename).join(", ")})`,
    );
  }

  const attachments: GmailAttachmentFile[] = [];
  for (const f of picked) {
    const data = f.inline ?? (await client.gmailGetAttachment(id, f.info.attachment_id!)).data;
    if (!data) throw new UsageError(`Gmail returned no data for attachment '${f.info.filename}' of ${id}`);
    const bytes = Buffer.from(data, "base64url");
    attachments.push({
      filename: f.info.filename,
      mime: f.info.mime,
      size: bytes.length,
      data_base64: bytes.toString("base64"),
    });
  }
  return { message_id: id, attachments };
}

// --- saving (runs on the machine the human is on) ------------------------------------------------------

/** A Gmail message id is hex; it also becomes a directory name, so anything else is refused. */
export function assertMessageId(id: string | undefined): string {
  if (!id) throw new UsageError("gmail needs a <message-id>");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new UsageError(`'${id}' is not a Gmail message id`);
  return id;
}

/** `$TMPDIR/ob-gmail/<message-id>/`: scratch lives under TMPDIR, never a hardcoded /tmp. */
export function defaultAttachmentDir(messageId: string): string {
  return join(process.env.TMPDIR || tmpdir(), "ob-gmail", messageId);
}

/** The sender chose this name, so keep only a plain file name: no path, no control characters. */
export function safeFileName(raw: string, fallback: string): string {
  const name = basename(raw.replace(/\\/g, "/"))
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point of this regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  return name === "" || name === "." || name === ".." ? fallback : name;
}

/** `invoice.pdf`, then `invoice (2).pdf` for a second attachment of the same name in one message. */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => {
    let candidate = n;
    for (let i = 2; seen.has(candidate); i++) {
      const dot = n.lastIndexOf(".");
      candidate = dot > 0 ? `${n.slice(0, dot)} (${i})${n.slice(dot)}` : `${n} (${i})`;
    }
    seen.add(candidate);
    return candidate;
  });
}

/**
 * Write the attachments into `dir` and return the paths. It never overwrites silently: if any target
 * exists the whole save is refused, before anything is written, unless `force` is set.
 */
export function saveAttachments(files: GmailAttachmentFile[], dir: string, opts: { force?: boolean | undefined } = {}): string[] {
  const names = uniqueNames(files.map((f, i) => safeFileName(f.filename, `attachment-${i + 1}`)));
  const paths = names.map((n) => join(dir, n));
  if (!opts.force) {
    const taken = paths.filter((p) => existsSync(p));
    if (taken.length > 0) {
      throw new UsageError(`refusing to overwrite ${taken.join(", ")} (use --force, or another --out)`);
    }
  }
  mkdirSync(dir, { recursive: true });
  files.forEach((f, i) => writeFileSync(paths[i]!, Buffer.from(f.data_base64, "base64")));
  return paths;
}

// --- rendering -----------------------------------------------------------------------------------------

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function renderMessage(m: GmailMessageRead): string {
  const head = [
    `message ${m.id}${m.thread_id ? ` (thread ${m.thread_id})` : ""}`,
    ...(m.from ? [`  from:    ${m.from}`] : []),
    ...(m.to ? [`  to:      ${m.to}`] : []),
    ...(m.cc ? [`  cc:      ${m.cc}`] : []),
    ...(m.date ? [`  date:    ${m.date}`] : []),
    `  subject: ${m.subject}`,
  ];
  const files =
    m.attachments.length === 0
      ? ["  attachments: none"]
      : [
          "  attachments:",
          ...m.attachments.map((a) => `    ${a.filename}\t${a.mime}\t${humanSize(a.size)}\t${a.attachment_id ?? "(inline)"}`),
        ];
  return [...head, ...files, "", m.body].join("\n");
}

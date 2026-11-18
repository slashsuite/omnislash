import { AppError, UsageError } from "../../../apps/cli/src/errors.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { header, decodeBody, parseAddr } from "./ingest/gmail.ts";
import {
  getGoogleToken,
  GoogleHttpError,
  HttpGoogleClient,
  type GmailDraft,
  type GmailDraftClient,
  type GmailSendAs,
  type GoogleFetch,
} from "./google.ts";
import { googleInvalidGrantRecorder } from "../../../apps/cli/src/credentials.ts";
import type { MasterKey } from "../../../apps/cli/src/secrets.ts";
import { fileParts, humanSize, listAttachments, messageText, type GmailAttachmentInfo } from "./gmail-message.ts";
import { createHash, randomUUID } from "node:crypto";

// -----------------------------------------------------------------------------
// 1757: Gmail drafts. The safety line is that nothing sends without a human's explicit word, so ob
// can CREATE a draft (any caller, any agent) and can SEND only an existing draft by id, behind a
// `confirm: true` that the CLI sets from `--confirm` alone. There is no one-shot send path here.
// -----------------------------------------------------------------------------

/** One file for a draft, as it crosses the API: the CLI reads it on ITS machine and sends the bytes. */
export interface GmailDraftAttachmentInput {
  filename: string;
  /** Defaults to application/octet-stream. */
  mime?: string;
  data_base64: string;
}

/** Gmail caps a message at 25 MB; base64 grows the files by a third, then drafts.create takes the whole thing as JSON, so stop well short. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface GmailDraftRequest {
  to: string;
  subject?: string;
  body: string;
  cc?: string;
  /**
   * OB-1961: send the draft as this Send-as address. Checked against Gmail's Send-as list (`resolveSendAs`);
   * absent → no lookup and no From header (Gmail uses the primary address).
   */
  from?: string;
  /** Gmail message id to reply to: threads the draft and sets In-Reply-To/References. */
  reply_to?: string;
  /** 1680: files to carry; a draft with any is multipart/mixed. */
  attachments?: GmailDraftAttachmentInput[];
}

/** What a draft is (or is about to be sent as): enough for a human to recognise it. */
export interface GmailDraftPreview {
  id: string;
  message_id: string | null;
  thread_id: string | null;
  /** OB-1961: the From header, or null when the draft has none (Gmail then uses the primary address). */
  from: string | null;
  to: string;
  cc: string | null;
  /** OB-1910: the Bcc header, present only when the draft has a non-empty one. */
  bcc?: string;
  subject: string;
  in_reply_to: string | null;
  preview: string;
  /**
   * OB-1910: `draftHash` of the draft as Gmail holds it, set when the preview is read back from Gmail
   * (`drafts --json`, the bare `send-draft <id>` preview). `send-draft --confirm --hash <hex>` sends only while
   * the draft still hashes to this. Absent on what `draft` / `draft-edit` return, which never send.
   */
  hash?: string;
  /** The files the draft carries (1680); absent from a host that predates attachments. */
  attachments?: Array<Pick<GmailAttachmentInfo, "filename" | "mime" | "size">>;
  /** OB-1752: true when the draft sits in Gmail's Trash (discarded in Gmail, still readable by id). Absent otherwise. */
  trashed?: boolean;
}

export interface GmailSendDraftResult extends GmailDraftPreview {
  sent_message_id: string;
}

/** OB-1750: `draft-edit` — each field present replaces that field; an absent one is kept as it is. */
export interface GmailDraftEdit {
  to?: string;
  /** OB-1961: replaces the draft's From (checked against the Send-as list); absent → the draft's From is kept. */
  from?: string;
  /** An empty string clears the Cc line. */
  cc?: string;
  subject?: string;
  body?: string;
  /** Present → replaces the draft's files (an empty array drops them all); absent → they are kept. */
  attachments?: GmailDraftAttachmentInput[];
}

/** What `draft-delete` removed: the draft as it was, so the human sees which one is gone. */
export interface GmailDeleteDraftResult extends GmailDraftPreview {
  deleted: true;
}

const PREVIEW_CHARS = 400;

/** Header values travel inside the raw RFC 2822 text, so a CR/LF in one would forge headers. */
function headerValue(name: string, v: string): string {
  if (/[\r\n]/.test(v)) throw new UsageError(`${name} must be a single line`);
  return v.trim();
}

/** RFC 2047 encoded-word for a non-ASCII header value; ASCII passes through unchanged. */
function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

function replySubject(original: string | null): string {
  const s = (original ?? "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** The From header for a matched Send-as entry: its own address, plus its display name when it has one. */
function fromHeaderOf(entry: GmailSendAs): string {
  const name = (entry.displayName ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!name) return entry.sendAsEmail;
  const phrase = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : encodeHeader(name);
  return `${phrase} <${entry.sendAsEmail}>`;
}

/**
 * OB-1961: check `--from` against Gmail's Send-as list and return the From header built from the MATCHED
 * entry (its address and display name), never from the raw string. Usable = listed and either the primary
 * address or `verificationStatus: "accepted"`. Anything else is refused, naming the usable addresses.
 */
async function resolveSendAs(client: GmailDraftClient, from: string): Promise<string> {
  const wanted = parseAddr(headerValue("from", from));
  if (!wanted) throw new UsageError("--from needs an address");
  let list: GmailSendAs[];
  try {
    list = await client.gmailListSendAs();
  } catch (e) {
    if (e instanceof GoogleHttpError && e.status === 403) {
      throw new UsageError(
        `--from ${wanted} cannot be checked: Gmail refused the Send-as list (403). The stored Google token needs the gmail.modify or gmail.settings.basic scope; re-authorise with it (ob google auth) and retry.`,
      );
    }
    throw e;
  }
  const usable = list.filter((a) => a.isPrimary === true || a.verificationStatus === "accepted");
  const hit = usable.find((a) => a.sendAsEmail.toLowerCase() === wanted);
  if (hit) return fromHeaderOf(hit);
  const known = list.find((a) => a.sendAsEmail.toLowerCase() === wanted);
  const why = known ? `is in the Send-as list but not verified (${known.verificationStatus ?? "unverified"})` : "is not one of this account's Send-as addresses";
  throw new UsageError(
    `--from ${wanted} ${why}. Usable Send-as addresses: ${usable.length ? usable.map((a) => a.sendAsEmail).join(", ") : "(none)"}. Add a new address in Gmail under Settings > Accounts > Send mail as.`,
  );
}

/** A validated attachment ready to be encoded. */
export interface RawAttachment {
  filename: string;
  mime: string;
  data: Buffer;
}

/** `attr="fallback"`, plus the RFC 2231 `attr*=UTF-8''...` form when the name is not plain ASCII. */
function fileNameParam(attr: string, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  if (ascii === name) return `${attr}="${name}"`;
  const pct = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${attr}="${ascii}"; ${attr}*=UTF-8''${pct}`;
}

const b64Lines = (data: Buffer): string => (data.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");

/** Build the base64url RFC 2822 message Gmail's `drafts.create` takes as `raw`. PURE. */
export function buildRawMessage(m: {
  /** OB-1961: a ready header value (`addr` or `"Name" <addr>`); written as the first header. */
  from?: string | null;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: RawAttachment[];
}): string {
  const lines = [...(m.from ? [`From: ${m.from}`] : []), `To: ${m.to}`];
  if (m.cc) lines.push(`Cc: ${m.cc}`);
  lines.push(`Subject: ${encodeHeader(m.subject)}`);
  if (m.inReplyTo) {
    lines.push(`In-Reply-To: ${m.inReplyTo}`);
    lines.push(`References: ${[m.references, m.inReplyTo].filter(Boolean).join(" ")}`);
  }
  lines.push("MIME-Version: 1.0");
  const textHeaders = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"];
  const bodyB64 = b64Lines(Buffer.from(m.body, "utf8"));
  const files = m.attachments ?? [];
  if (files.length === 0) {
    return Buffer.from(`${[...lines, ...textHeaders].join("\r\n")}\r\n\r\n${bodyB64}\r\n`, "utf8").toString("base64url");
  }
  // Every part below is base64 (or a header), and base64 has no "=_", so this boundary cannot appear in one.
  const boundary = `=_ob_${randomUUID()}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");
  const parts = [
    [...textHeaders, "", bodyB64].join("\r\n"),
    ...files.map((f) =>
      [
        `Content-Type: ${f.mime}; ${fileNameParam("name", f.filename)}`,
        `Content-Disposition: attachment; ${fileNameParam("filename", f.filename)}`,
        "Content-Transfer-Encoding: base64",
        "",
        b64Lines(f.data),
      ].join("\r\n"),
    ),
  ];
  const mime = parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("");
  return Buffer.from(`${lines.join("\r\n")}\r\n${mime}--${boundary}--\r\n`, "utf8").toString("base64url");
}

/** Decode and check the files of a request: single-line names, a sane MIME type, within Gmail's size. */
export function rawAttachments(
  inputs: GmailDraftAttachmentInput[] | undefined,
  limit = MAX_ATTACHMENT_BYTES,
): RawAttachment[] {
  let total = 0;
  const files = (inputs ?? []).map((a) => {
    if (typeof a?.filename !== "string" || a.filename === "") throw new UsageError("an attachment needs a filename");
    const filename = headerValue("attachment filename", a.filename);
    if (typeof a.data_base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data_base64)) {
      throw new UsageError(`attachment '${filename}' is not valid base64`);
    }
    const mime = a.mime && /^[\w.+-]+\/[\w.+-]+$/.test(a.mime) ? a.mime : "application/octet-stream";
    const data = Buffer.from(a.data_base64, "base64");
    total += data.length;
    return { filename, mime, data };
  });
  if (total > limit) {
    throw new UsageError(`attachments total ${humanSize(total)}; the limit is ${humanSize(limit)}`);
  }
  return files;
}

/**
 * OB-1910: what a human's yes binds to. The FULL decoded body (as draft-edit reads it, never the 400-char
 * preview), From (OB-1961), To, Cc, Bcc, Subject, and each file's name and Gmail-reported size, from the RAW draft. An
 * absent header is "". The digest is the first 12 hex chars of sha256 over a fixed-key JSON object. PURE.
 */
export function draftHash(draft: GmailDraft): string {
  const payload = draft.message?.payload;
  const canonical = JSON.stringify({
    from: header(payload, "From") ?? "",
    to: header(payload, "To") ?? "",
    cc: header(payload, "Cc") ?? "",
    bcc: header(payload, "Bcc") ?? "",
    subject: header(payload, "Subject") ?? "",
    body: messageText(payload),
    attachments: fileParts(payload).map((f) => [f.info.filename, f.info.size]),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
}

function previewOf(draft: GmailDraft): GmailDraftPreview {
  const payload = draft.message?.payload;
  const text = decodeBody(payload) || draft.message?.snippet || "";
  const bcc = header(payload, "Bcc");
  return {
    id: draft.id,
    message_id: draft.message?.id ?? null,
    thread_id: draft.message?.threadId ?? null,
    from: header(payload, "From"),
    to: header(payload, "To") ?? "",
    cc: header(payload, "Cc"),
    ...(bcc ? { bcc } : {}),
    subject: header(payload, "Subject") ?? "",
    in_reply_to: header(payload, "In-Reply-To"),
    preview: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text,
    attachments: listAttachments(payload).map(({ filename, mime, size }) => ({ filename, mime, size })),
    ...(draft.message?.labelIds?.includes("TRASH") ? { trashed: true } : {}),
    hash: draftHash(draft),
  };
}

/** Create a Gmail DRAFT. Never sends. With `reply_to` the draft joins that message's thread. */
export async function createGmailDraft(client: GmailDraftClient, req: GmailDraftRequest): Promise<GmailDraftPreview> {
  const to = headerValue("to", req.to ?? "");
  if (!to) throw new UsageError("gmail draft requires --to");
  const cc = req.cc ? headerValue("cc", req.cc) : undefined;
  if (!req.body) throw new UsageError("gmail draft requires --body or --body-file");

  let subject = req.subject != null ? headerValue("subject", req.subject) : undefined;
  let threadId: string | undefined;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  if (req.reply_to) {
    const orig = await client.gmailGetMessage(req.reply_to);
    threadId = orig.threadId;
    inReplyTo = header(orig.payload, "Message-ID") ?? header(orig.payload, "Message-Id");
    references = header(orig.payload, "References");
    subject ??= replySubject(header(orig.payload, "Subject"));
  }
  if (!subject) throw new UsageError("gmail draft requires --subject (or --reply-to to reuse the thread's)");

  const attachments = rawAttachments(req.attachments);
  const from = req.from !== undefined ? await resolveSendAs(client, req.from) : null;
  const raw = buildRawMessage({ from, to, cc, subject, body: req.body, inReplyTo, references, attachments });
  const created = await client.gmailCreateDraft({ raw, threadId });
  return {
    id: created.id,
    message_id: created.message?.id ?? null,
    thread_id: created.message?.threadId ?? threadId ?? null,
    from,
    to,
    cc: cc ?? null,
    subject,
    in_reply_to: inReplyTo,
    preview: req.body.length > PREVIEW_CHARS ? `${req.body.slice(0, PREVIEW_CHARS)}…` : req.body,
    attachments: attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.data.length })),
  };
}

/** Read an existing draft's recipients/subject/body preview. Never sends. */
export async function showGmailDraft(client: GmailDraftClient, id: string): Promise<GmailDraftPreview> {
  return previewOf(await client.gmailGetDraft(id));
}

/**
 * OB-1750: the newest `limit` drafts (default 20), one preview each. Reads only.
 * OB-1752: Trash included, flagged `trashed`. `drafts.list` leaves out a draft labelled TRASH unless asked
 * (`includeSpamTrash`), while `drafts.get` still returns it, so a draft discarded in Gmail was readable by
 * id and missing from the list: an empty list with exit 0 while drafts existed.
 */
export async function listGmailDrafts(client: GmailDraftClient, limit = 20): Promise<GmailDraftPreview[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("gmail drafts --limit must be a positive integer");
  const page = await client.gmailListDrafts({ maxResults: Math.min(limit, 500), includeSpamTrash: true });
  const ids = (page.drafts ?? []).map((d) => d.id);
  const out: GmailDraftPreview[] = [];
  for (const id of ids) out.push(await showGmailDraft(client, id));
  return out;
}

/**
 * OB-1750: edit an EXISTING draft in place (`drafts.update`; the id survives). Fields present in `edit`
 * replace what the draft has; everything else is read back from it and kept: the other recipients, the
 * thread and its In-Reply-To/References, the body and the files. The draft is rewritten as plain text, so
 * an HTML-only body becomes its text. Never sends.
 */
export async function editGmailDraft(client: GmailDraftClient, id: string, edit: GmailDraftEdit): Promise<GmailDraftPreview> {
  if (
    edit.to === undefined &&
    edit.from === undefined &&
    edit.cc === undefined &&
    edit.subject === undefined &&
    edit.body === undefined &&
    edit.attachments === undefined
  ) {
    throw new UsageError("gmail draft-edit needs something to change: --from, --to, --cc, --subject, --body/--body-file, --attach or --no-attach");
  }
  const existing = await client.gmailGetDraft(id);
  const payload = existing.message?.payload;
  const threadId = existing.message?.threadId;

  // OB-1961: the draft's existing From survives an edit unless --from replaces it.
  const from = edit.from !== undefined ? await resolveSendAs(client, edit.from) : (header(payload, "From") ?? null);
  const to = headerValue("to", edit.to ?? header(payload, "To") ?? "");
  if (!to) throw new UsageError("a draft needs a recipient (--to)");
  const ccRaw = edit.cc !== undefined ? headerValue("cc", edit.cc) : header(payload, "Cc");
  const cc = ccRaw || undefined;
  const subject = edit.subject !== undefined ? headerValue("subject", edit.subject) : (header(payload, "Subject") ?? "");
  const body = edit.body ?? messageText(payload);
  if (edit.body !== undefined && !edit.body) throw new UsageError("a draft body cannot be empty");

  const inReplyTo = header(payload, "In-Reply-To");
  // buildRawMessage appends In-Reply-To to References itself, so take it off the stored value first.
  let references = header(payload, "References");
  if (references && inReplyTo && references.trim().endsWith(inReplyTo)) {
    references = references.trim().slice(0, -inReplyTo.length).trim() || null;
  }

  let inputs = edit.attachments;
  // Files that are only being kept were already accepted by Gmail (up to 25 MB), so the 10 MB cap is for new ones.
  const keeping = inputs === undefined;
  if (inputs === undefined) {
    inputs = [];
    for (const f of fileParts(payload)) {
      const data = f.inline ?? (await client.gmailGetAttachment(existing.message!.id, f.info.attachment_id!)).data;
      if (!data) throw new AppError(`Gmail returned no data for attachment '${f.info.filename}' of draft ${id}`);
      inputs.push({ filename: f.info.filename, mime: f.info.mime, data_base64: Buffer.from(data, "base64url").toString("base64") });
    }
  }
  const attachments = rawAttachments(inputs, keeping ? Infinity : undefined);
  const raw = buildRawMessage({ from, to, cc, subject, body, inReplyTo, references, attachments });
  const updated = await client.gmailUpdateDraft(id, { raw, threadId });
  return {
    id: updated.id ?? id,
    message_id: updated.message?.id ?? null,
    thread_id: updated.message?.threadId ?? threadId ?? null,
    from,
    to,
    cc: cc ?? null,
    subject,
    in_reply_to: inReplyTo,
    preview: body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body,
    attachments: attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.data.length })),
  };
}

/**
 * OB-1750: delete a draft. `drafts.delete` removes it outright (no Trash), so like a send it needs
 * `confirm` literally true, which the CLI sets only from `--confirm`. The draft is read first: a wrong id
 * fails before anything is removed, and the result says which draft went. Sends nothing.
 */
export async function deleteGmailDraft(client: GmailDraftClient, id: string, confirm: boolean): Promise<GmailDeleteDraftResult> {
  if (confirm !== true) throw new UsageError(`gmail draft-delete ${id} refuses without --confirm`);
  const preview = await showGmailDraft(client, id);
  await client.gmailDeleteDraft(id);
  return { ...preview, deleted: true };
}

/**
 * Send an EXISTING draft. `confirm` must be literally true: the CLI sets it only from `--confirm`, and the
 * API refuses the request without it, so neither half can send on a default. OB-1910: `hash` must be the
 * `draftHash` the human read; the draft is read FRESH here, on the host, and sends only while it still
 * hashes to that. A draft in Gmail's Trash never sends.
 */
export async function sendGmailDraft(
  client: GmailDraftClient,
  id: string,
  confirm: boolean,
  hash: string,
): Promise<GmailSendDraftResult> {
  if (confirm !== true) throw new UsageError(`gmail send-draft ${id} refuses without --confirm`);
  if (typeof hash !== "string" || hash.trim() === "") {
    throw new UsageError(`gmail send-draft ${id} refuses without --hash: read the draft with ob gmail send-draft ${id} first`);
  }
  const draft = await client.gmailGetDraft(id);
  const preview = previewOf(draft);
  if (preview.trashed) {
    throw new UsageError(`gmail send-draft ${id} refuses: the draft is in Gmail's Trash. Nothing was sent.`);
  }
  if (preview.hash !== hash.trim()) {
    throw new UsageError(
      `gmail send-draft ${id} refuses: the draft changed since the hash you confirmed (it is now ${preview.hash}). Nothing was sent. Read it again with ob gmail send-draft ${id}, then re-run with --confirm --hash ${preview.hash}.`,
    );
  }
  const sent = await client.gmailSendDraft(id);
  if (!sent?.id) throw new AppError(`Gmail accepted send-draft ${id} but returned no message id`);
  return { ...preview, sent_message_id: sent.id };
}

/** The production client: secret `google` on THIS host (or the legacy token file). */
export async function gmailDraftClientFor(
  store: Store,
  opts: { fetch?: GoogleFetch; masterKey?: MasterKey } = {},
): Promise<GmailDraftClient> {
  const { token, persist } = await getGoogleToken(store, opts.masterKey);
  return new HttpGoogleClient(token, persist, { fetch: opts.fetch, onInvalidGrant: googleInvalidGrantRecorder(store) });
}

/** OB-1961: what the from line says when the draft has no From header, so an alias is never mistaken for the default. */
export const FROM_DEFAULT = "(Gmail default: primary address)";

/** The human-readable rendering both the local and the API command print. */
export function renderDraftPreview(p: GmailDraftPreview): string {
  return [
    `draft ${p.id}${p.thread_id ? ` (thread ${p.thread_id})` : ""}`,
    `  from:    ${p.from ?? FROM_DEFAULT}`,
    `  to:      ${p.to}`,
    ...(p.cc ? [`  cc:      ${p.cc}`] : []),
    ...(p.bcc ? [`  bcc:     ${p.bcc}`] : []),
    `  subject: ${p.subject}`,
    ...(p.trashed ? ["  trash:   this draft is in Gmail's Trash"] : []),
    ...(p.in_reply_to ? [`  reply:   ${p.in_reply_to}`] : []),
    ...(p.attachments ?? []).map((a) => `  attach:  ${a.filename} (${a.mime}, ${humanSize(a.size)})`),
    ...(p.hash ? [`  hash:    ${p.hash}`] : []),
    "",
    p.preview,
  ].join("\n");
}

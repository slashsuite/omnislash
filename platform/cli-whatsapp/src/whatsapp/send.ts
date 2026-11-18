import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { recordEventFor, eventsBetweenFor, parsePayload, nowIso } from "../../../../apps/cli/src/events.ts";
import { ingestJustSentMessage } from "../ingest/whatsapp.ts";
import { settingFor } from "../../../../apps/cli/src/settings.ts";
import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { expandHome } from "../../../../apps/cli/src/net.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";
import { shellWords } from "../../../../apps/cli/src/remote.ts";

// ── WhatsApp (personal) OUTBOUND send (101) — ob's FIRST outbound channel ─────────────────────────
// ob only ever talks to LOCALHOST: it POSTs the loopback Go bridge (127.0.0.1:8080), and the bridge is
// the one that talks to WhatsApp's servers — so ob keeps its "no direct remote HTTP" posture.
//
// #120 moved a line this module used to hold ("send-ONLY plumbing; it never reads or writes the bridge's
// SQLite DB"): a successful send now READS the bridge's messages.db, READ-ONLY, to recover the id of the
// message it just sent, and persists that row into whatsapp_message. It still NEVER writes the bridge.
// Why the read is necessary: the bridge's send response is `{success, message}` with NO message id, but it
// persists the message (with the real id) into messages.db before it answers — so the id already exists,
// and reading it is strictly better than minting our own. A locally-invented id would have to be reconciled
// to the real one on the next sync, and the dashboard's thread merge is keyed on `id`, so an id that CHANGES
// renders the same message as a SECOND bubble and strands its delivery ticks on the discarded row.
// The read is best-effort and narrow (see ingestJustSentMessage): if it cannot identify the row
// unambiguously it stores nothing and the 60s sync backfills as before — never a wrong id.
//
// THE HARD SAFETY LINE (from whatsapp-map.md): nothing sends without explicit human confirmation. The
// gate lives IN this module — sendWhatsapp() throws unless the caller passes the literal `confirm: true`,
// which a caller sets ONLY after a human said yes. Every caller (CLI + dashboard) inherits it; there is
// no code path to send without it. Claude never sets `confirm` on its own — a suggested reply is a draft.

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8080";

// ── attachments (ob 1683) ────────────────────────────────────────────────────────────────────────
// The bridge's `POST /api/send` takes an optional `media_path` (a local path the bridge process reads, so
// it must be absolute) and sends the file as an image or a document by its extension; `message` becomes the
// caption. ONE file per send. Only the kinds the owner actually sends are allowed: an allow-list, not "any
// file", because a typo'd `--file ~/.ssh/id_ed25519` must not become a document on someone's phone.
const ATTACHMENT_TYPES: Record<string, { mime: string; kind: "image" | "document" }> = {
  ".pdf": { mime: "application/pdf", kind: "document" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".png": { mime: "image/png", kind: "image" },
};

/** What the human is shown at the gate for one `--file`, and what the bridge is told. */
export interface WhatsappAttachment {
  /** Absolute path (the bridge resolves it on this machine). */
  path: string;
  /** Base name, shown to the recipient for a document. */
  name: string;
  size: number;
  mime: string;
  /** The `messages.media_type` the bridge stores: `image` for jpg/png, `document` for a PDF. */
  kind: "image" | "document";
}

/** Stat one file for sending. Throws a clean AppError for a missing/empty/non-file path or a type not on the allow-list. */
export function describeAttachment(file: string): WhatsappAttachment {
  const path = resolve(expandHome(file));
  const type = ATTACHMENT_TYPES[extname(path).toLowerCase()];
  if (!type) {
    throw new AppError(
      `cannot send ${file}: only ${Object.keys(ATTACHMENT_TYPES).join(", ")} files can be attached to a WhatsApp message`,
    );
  }
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("not a regular file");
    size = st.size;
  } catch (e) {
    throw new AppError(`cannot read --file ${file}: ${(e as Error).message}`);
  }
  if (size === 0) throw new AppError(`cannot send ${file}: the file is empty`);
  return { path, name: basename(path), size, mime: type.mime, kind: type.kind };
}

/** The lines the human reads at the confirm gate: recipient, full caption/body, and every file's name/size/mime. */
export function sendGateLines(to: string, body: string | undefined, files: WhatsappAttachment[]): string[] {
  const lines = [
    `WhatsApp send — this will deliver a real message${files.length > 1 ? ` per file (${files.length})` : ""}.`,
    `  to:   ${to}`,
    `  ${files.length > 0 ? "caption" : "body"}: ${body || "(none)"}`,
  ];
  for (const f of files) lines.push(`  file: ${f.name}  ${f.size} bytes  ${f.mime}  (sent as ${f.kind})`);
  if (files.length > 1 && body) lines.push("  (the caption goes on the first file only)");
  return lines;
}

/** The bridge's `POST /api/send` response shape (`{"success": bool, "message": "..."}`). */
interface BridgeSendResponse {
  success?: boolean;
  message?: string;
}

export interface SendWhatsappOpts {
  /** Recipient chat JID (e.g. `27000000003@s.whatsapp.net` or a `@g.us` group). */
  to: string;
  /** Message text; with `file`, the caption (may then be empty). */
  body: string;
  /**
   * One attachment (ob 1683), already described via `describeAttachment`. The confirm gate is unchanged:
   * a file goes out only under `confirm === true`, like text.
   */
  file?: WhatsappAttachment;
  /**
   * The confirmation gate. MUST be the literal `true`, set by a caller ONLY after a human confirmed the
   * send. No default — undefined/false/truthy-but-not-true are all refused. Never wire this to an env/flag.
   */
  confirm: boolean;
  /**
   * OB-1909: send even though an identical send in the last 24 h ended with an unknown outcome (a bridge
   * 5xx). Only the human sets it, after checking the chat; without it that send refuses.
   */
  resend?: boolean;
  /** Transport seam — tests inject a mock so they NEVER hit the network. Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Bridge messages.db handle for the post-send id pickup (#120) — tests inject a fixture so they never
   * read a real bridge. Runtime opens `whatsapp_db_path` READ-ONLY.
   */
  bridge?: Database;
  /**
   * Bridge contacts DB handle (whatsapp.db) for the `@lid` → phone-jid map used to resolve the chat before
   * the pickup match — tests inject a fixture. Runtime derives `whatsapp_contacts_db_path`.
   */
  contacts?: Database;
}

export interface SendWhatsappResult {
  ok: boolean;
  to: string;
  response: BridgeSendResponse;
  /**
   * The bridge message id of the row persisted at send time (#120), or null when the pickup could not
   * identify it unambiguously — then the row lands on the next sync instead, as it did before #120.
   */
  id: string | null;
}

/** The bridge itself failed (5xx), so it may have delivered the message before it did. */
export class BridgeOutcomeUnknown extends AppError {}

/** OB-1909: an identical send in the last 24 h ended with an unknown outcome, so this one refuses. */
export class SendMaybeAlreadyGone extends AppError {}

/**
 * The words every SendMaybeAlreadyGone message ends with. Over the API the refusal arrives as a plain 409,
 * so the client recognises it by these words and rethrows it unchanged rather than as a partial send.
 */
export const MAYBE_ALREADY_GONE_TAIL = "--resend sends it anyway.";

/** How far back an unknown outcome blocks an identical send (OB-1909). */
const SEND_UNKNOWN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * OB-1909: what makes two sends "the same send": recipient, text and the file's name and size (not its
 * content, accepted). The first 16 hex chars of a sha256, stored on the `sent` and `send_unknown` events.
 */
export function sendKey(opts: { to: string; body: string; file?: { name: string; size: number } }): string {
  const json = JSON.stringify({ to: opts.to, body: opts.body, file: opts.file ? [opts.file.name, opts.file.size] : null });
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/**
 * The newest `sent` or `send_unknown` event in the last 24 h carrying this key, or null. Only a
 * `send_unknown` that is the newest refuses, so a later successful send (a `--resend`) clears it.
 */
async function lastAttemptFor(store: Store, key: string): Promise<{ type: string; ts: string } | null> {
  const since = new Date(Date.now() - SEND_UNKNOWN_WINDOW_MS).toISOString();
  const rows = (
    await Promise.all(
      ["sent", "send_unknown"].map((type) => eventsBetweenFor(store, { source: "whatsapp", type, since })),
    )
  ).flat();
  let newest: { type: string; ts: string; id: number } | null = null;
  for (const r of rows) {
    const payload = parsePayload<{ key?: unknown } | null>(r);
    if (payload?.key !== key) continue;
    if (!newest || r.ts > newest.ts || (r.ts === newest.ts && r.id > newest.id)) {
      newest = { type: r.type ?? "", ts: r.ts, id: r.id };
    }
  }
  return newest;
}

/**
 * OB-1909: refuse when the newest identical attempt in the last 24 h has an unknown outcome.
 */
async function assertNotMaybeAlreadyGone(
  store: Store,
  opts: { to: string; body: string; file?: { name: string; size: number }; resend?: boolean },
): Promise<void> {
  if (opts.resend === true) return;
  const last = await lastAttemptFor(store, sendKey(opts));
  if (last?.type !== "send_unknown") return;
  throw new SendMaybeAlreadyGone(
    `an identical WhatsApp send to ${opts.to} at ${last.ts} may already have gone (the bridge failed mid-send). ` +
      `Check the chat (in WhatsApp, or ob whatsapp recent) before sending again; ${MAYBE_ALREADY_GONE_TAIL}`,
  );
}

/**
 * OB-1909: the text a multi-file send throws when file index `sent` failed. It names the files that went
 * and ends with the exact command that sends only the files that surely did not go. On a 5xx, or a
 * may-already-have-gone refusal (`failedUnknown`), the failed file may have gone, so it gets its own command, with `--resend` (its
 * attempt is now on record) and the caption when it was the first file; the command for the rest then
 * carries no caption. On a 4xx the rest starts at the failed file and carries `--body` only when that was
 * the first file. `files` are the paths as the human typed them.
 */
export function partialSendMessage(opts: {
  to: string;
  body?: string;
  files: string[];
  sent: number;
  failedUnknown: boolean;
}): string {
  const { to, body, files, sent, failedUnknown } = opts;
  const failed = files[sent]!;
  const cmd = (withBody: boolean, fs: string[], resend = false) =>
    shellWords([
      "ob", "whatsapp", "send", "--to", to,
      ...(withBody && body ? ["--body", body] : []),
      ...fs.flatMap((f) => ["--file", f]),
      ...(resend ? ["--resend"] : []),
    ]);
  const lines = [`sent ${sent} of ${files.length} files to ${to}.`];
  lines.push(sent > 0 ? `went: ${files.slice(0, sent).join(", ")}` : "went: none");
  const rest = files.slice(failedUnknown ? sent + 1 : sent);
  if (failedUnknown) {
    lines.push(
      `${failed} may have gone: check the chat (in WhatsApp, or ob whatsapp recent). If it did not: ${cmd(sent === 0, [failed], true)}`,
    );
  } else {
    lines.push(`${failed} was not sent.`);
  }
  if (rest.length > 0) lines.push(`To send the rest: ${cmd(sent === 0 && !failedUnknown, rest)}`);
  return lines.join("\n");
}

/** Read the bridge bearer token from the file at `whatsapp_bridge_token_path`. Clean AppError if absent. */
export async function readBridgeToken(store: Store): Promise<string> {
  const path = await settingFor(store, "whatsapp_bridge_token_path");
  try {
    return readFileSync(expandHome(path), "utf8").trim();
  } catch {
    throw new AppError(
      `cannot read WhatsApp bridge token at ${path} (set config whatsapp_bridge_token_path, and run the bridge so it creates .bridge-token)`,
    );
  }
}

/**
 * Send a WhatsApp message via the local Go bridge (`POST {whatsapp_bridge_url}/api/send`, Bearer auth).
 * THROWS immediately unless `confirm === true` — the hard safety gate every caller inherits. On success it
 * PERSISTS the sent message into whatsapp_message (#120 — picking the real bridge id back out of the
 * bridge's messages.db, read-only; see ingestJustSentMessage, which stores nothing rather than guess) so
 * the message is a real row immediately instead of appearing up to 60s later, then mirrors an
 * `event(source='whatsapp', type='sent')` for the audit trail / feed and returns the result. The transport
 * and both bridge handles are injectable so tests never touch the network or a real bridge.
 */
export async function sendWhatsapp(
  store: Store,
  opts: SendWhatsappOpts,
): Promise<SendWhatsappResult> {
  // ── the gate: strict === true, no default, no truthy coercion ──
  if (opts.confirm !== true) {
    throw new AppError(
      "refusing to send WhatsApp message: no explicit confirmation (sendWhatsapp requires confirm === true, set only after a human confirms)",
    );
  }

  const { to, body } = opts;
  if (!to) throw new AppError("whatsapp send requires a recipient (to)");
  if (!body && !opts.file) throw new AppError("whatsapp send requires a message body");

  // OB-1909: an identical send whose outcome is unknown refuses, unless the human said --resend.
  const key = sendKey({ to, body, file: opts.file });
  await assertNotMaybeAlreadyGone(store, { to, body, file: opts.file, resend: opts.resend });

  const base = (await settingFor(store, "whatsapp_bridge_url")) || DEFAULT_BRIDGE_URL;
  const token = await readBridgeToken(store);
  const doFetch = opts.fetch ?? fetch;

  const url = `${base.replace(/\/$/, "")}/api/send`;
  const sentAt = Date.now(); // the centre of the pickup's match window (#120)
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      recipient: to,
      message: body,
      ...(opts.file ? { media_path: opts.file.path } : {}),
    }),
  });

  let json: BridgeSendResponse = {};
  try {
    json = (await res.json()) as BridgeSendResponse;
  } catch {
    /* non-JSON body — handled by the status/success checks below */
  }

  if (!res.ok) {
    const message = `WhatsApp bridge send failed (${res.status})${json.message ? `: ${json.message}` : ""}`;
    if (res.status < 500) throw new AppError(message);
    // OB-1909: it may have gone, so remember the attempt; an identical send then refuses. A failed record
    // still throws the unknown outcome, saying the attempt was not remembered.
    try {
      await recordEventFor(store, {
        ts: nowIso(),
        source: "whatsapp",
        type: "send_unknown",
        actor: to,
        payload: {
          key,
          chat_jid: to,
          body_preview: body.slice(0, 80),
          ...(opts.file ? { media: { name: opts.file.name, size: opts.file.size } } : {}),
          status: res.status,
        },
      });
    } catch (e) {
      throw new BridgeOutcomeUnknown(`${message} (could not record the attempt: ${(e as Error).message})`);
    }
    throw new BridgeOutcomeUnknown(message);
  }
  if (json.success === false) {
    throw new AppError(`WhatsApp bridge send failed: ${json.message ?? "unknown error"}`);
  }

  const id = await ingestJustSentMessage(store, {
    chatJid: to,
    content: body,
    mediaType: opts.file?.kind,
    sentAt,
    bridge: opts.bridge,
    contacts: opts.contacts,
  });

  await recordEventFor(store, {
    ts: nowIso(),
    source: "whatsapp",
    type: "sent",
    actor: to,
    payload: {
      key,
      chat_jid: to,
      body_preview: body.slice(0, 80),
      length: body.length,
      ...(opts.file
        ? { media: { name: opts.file.name, size: opts.file.size, mime: opts.file.mime, type: opts.file.kind } }
        : {}),
      response: json.message ?? null,
    },
  });

  return { ok: true, to, response: json, id };
}

import type { Ctx } from "../../../../apps/cli/src/ctx.ts";
import { UsageError } from "../../../../apps/cli/src/errors.ts";
import { print, type Mode } from "../../../../apps/cli/src/output.ts";
import { recentEmail, searchEmail, syncGmail, type EmailHit } from "../ingest/gmail.ts";
import { sqliteStoreFor } from "../../../../apps/cli/src/db/store.ts";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Flags } from "../../../../apps/cli/src/ctx.ts";
import {
  createGmailDraft,
  deleteGmailDraft,
  FROM_DEFAULT,
  editGmailDraft,
  gmailDraftClientFor,
  listGmailDrafts,
  renderDraftPreview,
  sendGmailDraft,
  showGmailDraft,
  type GmailDeleteDraftResult,
  type GmailDraftEdit,
  type GmailDraftPreview,
  type GmailDraftRequest,
  type GmailSendDraftResult,
  type GmailDraftAttachmentInput,
  MAX_ATTACHMENT_BYTES,
} from "../gmail-draft.ts";
import {
  assertMessageId,
  defaultAttachmentDir,
  fetchGmailAttachments,
  humanSize,
  readGmailMessage,
  renderMessage,
  saveAttachments,
  type GmailAttachmentsResult,
  type GmailMessageRead,
} from "../gmail-message.ts";

export const GMAIL_SUBS = "sync|search|list|read|attachment|draft|drafts|draft-edit|draft-delete|send-draft";

/** 1680: `--attach <file>` (repeatable) read HERE, so only the bytes cross the API. */
export function attachmentsFromFlags(flags: Flags): GmailDraftAttachmentInput[] {
  let total = 0;
  return (flags.attach ?? []).map((path) => {
    let data: Buffer;
    try {
      if (!statSync(path).isFile()) throw new Error("not a regular file");
      data = readFileSync(path);
    } catch (e) {
      throw new UsageError(`cannot read --attach ${path}: ${(e as Error).message}`);
    }
    total += data.length;
    // Fail on the machine that has the files, before the bytes are sent anywhere.
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new UsageError(`--attach files total over ${humanSize(MAX_ATTACHMENT_BYTES)}; Gmail would refuse the message`);
    }
    return {
      filename: basename(path),
      mime: Bun.file(path).type.split(";")[0] || "application/octet-stream",
      data_base64: data.toString("base64"),
    };
  });
}

/** `--body` or `--body-file` (read HERE); undefined when neither is given. */
export function bodyFromFlags(flags: Flags, cmd: string): string | undefined {
  if (flags.body != null && flags["body-file"] != null) {
    throw new UsageError(`${cmd} takes --body or --body-file, not both`);
  }
  if (flags["body-file"] == null) return flags.body;
  try {
    return readFileSync(flags["body-file"], "utf8");
  } catch (e) {
    throw new UsageError(`cannot read --body-file ${flags["body-file"]}: ${(e as Error).message}`);
  }
}

/**
 * OB-1750: `gmail draft-edit` flags → the edit. Only what was passed is in it: `--attach` replaces the
 * draft's files, `--no-attach` drops them, and with neither they are kept.
 */
export function draftEditFromFlags(flags: Flags): GmailDraftEdit {
  if (flags["no-attach"] && (flags.attach ?? []).length > 0) {
    throw new UsageError("gmail draft-edit takes --attach or --no-attach, not both");
  }
  const attachments = flags["no-attach"] ? [] : attachmentsFromFlags(flags);
  const body = bodyFromFlags(flags, "gmail draft-edit");
  return {
    ...(flags.from != null ? { from: flags.from } : {}),
    ...(flags.to != null ? { to: flags.to } : {}),
    ...(flags.cc != null ? { cc: flags.cc } : {}),
    ...(flags.subject != null ? { subject: flags.subject } : {}),
    ...(body != null ? { body } : {}),
    ...(flags["no-attach"] || attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * 1757: `gmail draft` flags → the request. `--body-file` is read HERE (the machine the human is on), so
 * over the API only the text travels. Validation of to/subject is the draft module's.
 */
export function draftRequestFromFlags(flags: Flags): GmailDraftRequest {
  const body = bodyFromFlags(flags, "gmail draft");
  if (!flags.to) throw new UsageError("gmail draft requires --to");
  if (!body) throw new UsageError("gmail draft requires --body or --body-file");
  const attachments = attachmentsFromFlags(flags);
  return {
    to: flags.to,
    subject: flags.subject,
    body,
    cc: flags.cc,
    ...(flags.from != null ? { from: flags.from } : {}),
    reply_to: flags["reply-to"],
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function messageIdArg(args: string[]): string {
  return assertMessageId(args[1]);
}

/** `gmail attachment` on this machine: write what the host returned and report where it went. */
export function saveFetchedAttachments(res: GmailAttachmentsResult, flags: Flags, mode: Mode): string {
  const dir = flags.out ?? defaultAttachmentDir(res.message_id);
  const paths = saveAttachments(res.attachments, dir, { force: flags.force });
  if (mode === "json") {
    return JSON.stringify(
      {
        message_id: res.message_id,
        saved: res.attachments.map((a, i) => ({ path: paths[i], filename: a.filename, mime: a.mime, size: a.size })),
      },
      null,
      2,
    );
  }
  return paths.join("\n");
}

export function renderRead(m: GmailMessageRead, mode: Mode): string {
  return mode === "json" ? JSON.stringify(m, null, 2) : renderMessage(m);
}

export function sendDraftId(args: string[]): string {
  const id = args[1];
  if (!id) throw new UsageError("gmail send-draft requires a <draft-id>");
  return id;
}

export function draftIdArg(args: string[], sub: string): string {
  const id = args[1];
  if (!id) throw new UsageError(`gmail ${sub} requires a <draft-id>`);
  return id;
}

/** `gmail drafts`: one line per draft, `id<TAB>to<TAB>subject`, plus `<TAB>[trash]` for one in Gmail's Trash (OB-1752). */
export function renderDraftList(drafts: GmailDraftPreview[]): string {
  return drafts.map((d) => `${d.id}\t${d.to || "-"}\t${d.subject || "(no subject)"}${d.trashed ? "\t[trash]" : ""}`).join("\n");
}

/** `gmail draft-edit` output: the draft as it now stands, and the one way to send it. */
export function renderEditedDraft(p: GmailDraftPreview): string {
  return `${renderDraftPreview(p)}\n\nDRAFT UPDATED — nothing was sent. To review it for sending: ob gmail send-draft ${p.id}`;
}

/** `gmail draft-delete` without `--confirm`: show which draft would go, then refuse (exit 2). */
export function refuseUnconfirmedDelete(p: GmailDraftPreview): never {
  print(renderDraftPreview(p));
  throw new UsageError(
    `gmail draft-delete ${p.id} refuses without --confirm. Gmail removes the draft outright (it does not go to Trash); re-run with --confirm to delete it.`,
  );
}

export function renderDeleted(r: GmailDeleteDraftResult): string {
  return `deleted draft ${r.id} (nothing was sent)\n  from:    ${r.from ?? FROM_DEFAULT}\n  to:      ${r.to}${r.cc ? `\n  cc:      ${r.cc}` : ""}\n  subject: ${r.subject}`;
}

/** `gmail draft` output: the id plus the preview, and the one way to send it. */
export function renderCreatedDraft(p: GmailDraftPreview): string {
  return `${renderDraftPreview(p)}\n\nDRAFT ONLY — nothing was sent. To review it for sending: ob gmail send-draft ${p.id}`;
}

/**
 * OB-1910: `--hash <hex>` as `send-draft` passes it on, or undefined when the call is not a full confirm
 * (`--confirm` AND a non-empty `--hash`), in which case the command shows the preview and refuses.
 */
export function confirmedSendHash(flags: Flags): string | undefined {
  const hash = flags.hash?.trim();
  return flags.confirm === true && hash ? hash : undefined;
}

/** `gmail send-draft` without `--confirm --hash`: show what WOULD go, with its hash, then refuse (exit 2). */
export function refuseUnconfirmed(p: GmailDraftPreview): never {
  print(renderDraftPreview(p));
  if (p.trashed) {
    throw new UsageError(`gmail send-draft ${p.id} refuses: the draft is in Gmail's Trash, so it cannot be sent.`);
  }
  throw new UsageError(
    `gmail send-draft ${p.id} refuses without --confirm and --hash. Read the recipients, subject and body above; to send exactly this: ob gmail send-draft ${p.id} --confirm --hash ${p.hash ?? "<hex>"}`,
  );
}

export function renderSent(r: GmailSendDraftResult): string {
  return `sent draft ${r.id} → message ${r.sent_message_id}\n  from:    ${r.from ?? FROM_DEFAULT}\n  to:      ${r.to}${r.cc ? `\n  cc:      ${r.cc}` : ""}\n  subject: ${r.subject}`;
}

export function renderHits(hits: EmailHit[]): string {
  return hits
    .map((h) => `${h.id}\t${h.ts ?? ""}\t${h.from_addr ?? "-"}\t${h.subject ?? "(no subject)"}`)
    .join("\n");
}

export async function cmdGmail(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  const store = ctx.store ?? sqliteStoreFor(ctx.db);

  if (sub === "sync") {
    const res = await syncGmail(store, {
      backfill: ctx.flags.backfill,
      query: ctx.flags.query,
      days: ctx.flags.days != null ? Number(ctx.flags.days) : undefined,
      since: ctx.flags.since,
      max: ctx.flags.max != null ? Number(ctx.flags.max) : undefined,
    });
    if (ctx.mode === "json") {
      print(JSON.stringify(res, null, 2));
    } else {
      print(
        `gmail sync — ${res.messages} fetched, ${res.skipped} skipped, ${res.ingested} new (cursor ${res.cursor ?? "-"})`,
      );
    }
    return;
  }

  if (sub === "search") {
    const query = ctx.args.slice(1).join(" ");
    if (!query) throw new UsageError("gmail search requires a <query>");
    const hits = await searchEmail(store, query, ctx.flags.limit ? Number(ctx.flags.limit) : 20);
    if (ctx.mode === "json") print(JSON.stringify(hits, null, 2));
    else print(renderHits(hits));
    return;
  }

  if (sub === "list") {
    const hits = await recentEmail(store, {
      since: ctx.flags.since,
      limit: ctx.flags.limit ? Number(ctx.flags.limit) : 20,
    });
    if (ctx.mode === "json") print(JSON.stringify(hits, null, 2));
    else print(renderHits(hits));
    return;
  }

  if (sub === "read") {
    const m = await readGmailMessage(await gmailDraftClientFor(store), messageIdArg(ctx.args));
    print(renderRead(m, ctx.mode));
    return;
  }

  if (sub === "attachment") {
    const id = messageIdArg(ctx.args);
    const res = await fetchGmailAttachments(await gmailDraftClientFor(store), id, ctx.flags.name);
    print(saveFetchedAttachments(res, ctx.flags, ctx.mode));
    return;
  }

  if (sub === "draft") {
    const req = draftRequestFromFlags(ctx.flags);
    const res = await createGmailDraft(await gmailDraftClientFor(store), req);
    print(ctx.mode === "json" ? JSON.stringify(res, null, 2) : renderCreatedDraft(res));
    return;
  }

  if (sub === "drafts") {
    const drafts = await listGmailDrafts(await gmailDraftClientFor(store), ctx.flags.limit ? Number(ctx.flags.limit) : undefined);
    print(ctx.mode === "json" ? JSON.stringify(drafts, null, 2) : renderDraftList(drafts));
    return;
  }

  if (sub === "draft-edit") {
    const id = draftIdArg(ctx.args, "draft-edit");
    const res = await editGmailDraft(await gmailDraftClientFor(store), id, draftEditFromFlags(ctx.flags));
    print(ctx.mode === "json" ? JSON.stringify(res, null, 2) : renderEditedDraft(res));
    return;
  }

  if (sub === "draft-delete") {
    const id = draftIdArg(ctx.args, "draft-delete");
    const client = await gmailDraftClientFor(store);
    if (ctx.flags.confirm !== true) refuseUnconfirmedDelete(await showGmailDraft(client, id));
    const res = await deleteGmailDraft(client, id, true);
    print(ctx.mode === "json" ? JSON.stringify(res, null, 2) : renderDeleted(res));
    return;
  }

  if (sub === "send-draft") {
    const id = sendDraftId(ctx.args);
    const client = await gmailDraftClientFor(store);
    const hash = confirmedSendHash(ctx.flags);
    if (hash === undefined) refuseUnconfirmed(await showGmailDraft(client, id));
    const res = await sendGmailDraft(client, id, true, hash);
    print(ctx.mode === "json" ? JSON.stringify(res, null, 2) : renderSent(res));
    return;
  }

  throw new UsageError(`unknown gmail subcommand '${sub ?? ""}' (${GMAIL_SUBS})`);
}

// ob 1757 -- a fake Gmail drafts seam shared by the cli-sources and cli-core tests: records every create
// and send, so a test can assert that nothing was sent.
import type { GmailAttachmentBody, GmailDraft, GmailDraftClient, GmailDraftListResponse, GmailMessage, GmailSendAs } from "../src/google.ts";

export class FakeDraftClient implements GmailDraftClient {
  created: Array<{ raw: string; threadId?: string }> = [];
  sent: string[] = [];
  /** OB-1750: every `drafts.update` and `drafts.delete`, so a test can assert what was (and was not) touched. */
  updated: Array<{ id: string; raw: string; threadId?: string }> = [];
  deleted: string[] = [];
  drafts = new Map<string, GmailDraft>();
  messages = new Map<string, GmailMessage>();
  /** 1680: attachment bodies keyed `<messageId>/<attachmentId>`; `attachmentFetches` records each call. */
  attachments = new Map<string, GmailAttachmentBody>();
  attachmentFetches: string[] = [];
  /** OB-1961: the account's Send-as list; `sendAsCalls` counts lookups so a test can assert there was none. */
  sendAs: GmailSendAs[] = [{ sendAsEmail: "me@example.com", isPrimary: true, isDefault: true, verificationStatus: undefined }];
  sendAsCalls = 0;
  /** Set to make the lookup fail the way Gmail does (e.g. a 403 for a token without the scope). */
  sendAsError?: Error;
  gmailListSendAs(): Promise<GmailSendAs[]> {
    this.sendAsCalls++;
    return this.sendAsError ? Promise.reject(this.sendAsError) : Promise.resolve(this.sendAs);
  }
  gmailGetMessage(id: string): Promise<GmailMessage> {
    const m = this.messages.get(id);
    return m ? Promise.resolve(m) : Promise.reject(new Error(`no message ${id}`));
  }
  gmailGetAttachment(messageId: string, attachmentId: string): Promise<GmailAttachmentBody> {
    const key = `${messageId}/${attachmentId}`;
    this.attachmentFetches.push(key);
    const a = this.attachments.get(key);
    return a ? Promise.resolve(a) : Promise.reject(new Error(`no attachment ${key}`));
  }
  gmailCreateDraft(req: { raw: string; threadId?: string }): Promise<GmailDraft> {
    this.created.push(req);
    return Promise.resolve({ id: `r${this.created.length}`, message: { id: `m${this.created.length}`, threadId: req.threadId ?? "t-new" } });
  }
  gmailGetDraft(id: string): Promise<GmailDraft> {
    const d = this.drafts.get(id);
    return d ? Promise.resolve(d) : Promise.reject(new Error(`no draft ${id}`));
  }
  gmailSendDraft(id: string): Promise<GmailMessage> {
    this.sent.push(id);
    return Promise.resolve({ id: `sent-${id}`, threadId: "t1" });
  }
  gmailListDrafts(opts: { maxResults?: number; pageToken?: string; includeSpamTrash?: boolean }): Promise<GmailDraftListResponse> {
    // Newest first, like Gmail. OB-1752: like Gmail, a draft labelled TRASH is left out unless `includeSpamTrash`
    // is set, though `gmailGetDraft` still returns it. A fake that lists everything hid this for a release.
    const visible = [...this.drafts.values()].reverse().filter((d) => opts.includeSpamTrash || !d.message?.labelIds?.includes("TRASH"));
    const all = visible.slice(0, opts.maxResults ?? 100);
    return Promise.resolve({ drafts: all.map((d) => ({ id: d.id, message: d.message && { id: d.message.id } })) });
  }
  gmailUpdateDraft(id: string, req: { raw: string; threadId?: string }): Promise<GmailDraft> {
    if (!this.drafts.has(id)) return Promise.reject(new Error(`no draft ${id}`));
    this.updated.push({ id, ...req });
    return Promise.resolve({ id, message: { id: `m-upd-${this.updated.length}`, threadId: req.threadId ?? "t-new" } });
  }
  gmailDeleteDraft(id: string): Promise<void> {
    if (!this.drafts.has(id)) return Promise.reject(new Error(`no draft ${id}`));
    this.deleted.push(id);
    this.drafts.delete(id);
    return Promise.resolve();
  }
}

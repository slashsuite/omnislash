// `ob send <team> <role> "<body>"` and `ob inbox <team> <role>`: a team role's inbox (see ../inbox.ts for the record).
//
// One procedure serves the store and the API client: each passes an `InboxBackend` for the data.
import type { Ctx, Flags } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { listRoleMessages, markRoleMessagesRead, parseMessageIds, sendRoleMessage, type RoleMessage, type RoleMessageInput } from "../inbox.ts";
import { print, warn, type Mode } from "../output.ts";
import type { Database } from "bun:sqlite";
import type { Store } from "../db/store.ts";
import { deliverToRole, renderDelivery, type DeliverOutcome } from "../role-deliver.ts";
import { t3Seam } from "../t3/dispatch.ts";
import { storeRoleBackend } from "./role.ts";
import { parseTeamRole } from "../team-handoff.ts";
import type { TeamRole } from "../team.ts";
import { refuseUnreadFlags } from "./capture.ts";
import { bodyFromFlags } from "./doc.ts";

/** Where the messages live: the store on this machine, or the API. */
export interface InboxBackend {
  send(input: RoleMessageInput): Promise<{ message: RoleMessage; created: boolean }>;
  list(team: string, role: TeamRole, all: boolean): Promise<RoleMessage[]>;
  read(team: string, role: TeamRole, ids: number[], by: string): Promise<RoleMessage[]>;
}

export interface InboxCtx {
  mode: Mode;
  flags: Flags;
  args: string[];
  exit?: number;
}

/** OS-56: deliver the role's unread messages into its run (see ../role-deliver.ts). */
export type Deliver = (team: string, role: TeamRole) => Promise<DeliverOutcome>;

/** The sender when `--from` is not given. */
const DEFAULT_FROM = "owner";

function teamAndRole(command: string, args: string[]): { team: string; role: TeamRole } {
  const team = args[0];
  if (!team) throw new UsageError(`${command} requires <team> <role>`);
  return { team, role: parseTeamRole(args[1], "<role>") };
}

function renderMessage(m: RoleMessage): string {
  const ref = m.ref ? ` ${m.ref}` : "";
  const read = m.read_at ? `; read ${m.read_at} by ${m.read_by}` : "";
  const withdrawn = m.withdrawn_at ? `; withdrawn ${m.withdrawn_at}` : "";
  return [`#${m.id} ${m.kind}${ref} from ${m.from_actor} at ${m.created_at}${read}${withdrawn}`, ...m.body.split("\n").map((l) => `  ${l}`)].join("\n");
}

/**
 * `ob send <team> <role> "<body>" [--body-file <path>] [--from <id>] [--no-deliver]`. The message is stored first, then
 * delivered into the role's run (OS-56); a delivery that fails leaves it stored and unread, and exits 1.
 */
export async function runSend(ctx: InboxCtx, backend: InboxBackend, deliver: Deliver): Promise<void> {
  refuseUnreadFlags("ob send", ctx.flags, ["body-file", "from", "no-deliver"]);
  const { team, role } = teamAndRole("send", ctx.args);
  const inline = ctx.args.slice(2);
  const fromFile = bodyFromFlags({ "body-file": ctx.flags["body-file"] });
  if (fromFile !== undefined && inline.length > 0) throw new UsageError("pass the message as text or --body-file, not both");
  const body = fromFile ?? inline.join(" ");
  if (!body.trim()) throw new UsageError(`send needs a message: ob send ${team} ${role} "<text>" (or --body-file <path>)`);
  const from = ctx.flags.from?.trim() || DEFAULT_FROM;
  const { message } = await backend.send({ team, role, from, kind: "message", body });
  let delivery: DeliverOutcome | null = null;
  let failure: string | null = null;
  if (ctx.flags["no-deliver"] !== true) {
    try {
      delivery = await deliver(team, role);
    } catch (err) {
      failure = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
    }
  }
  if (ctx.mode === "json") print(JSON.stringify({ ...message, delivery, delivery_error: failure }, null, 2));
  else if (ctx.mode === "quiet") print(String(message.id));
  else print(`${team} ${role}: message #${message.id} stored${delivery ? `; ${renderDelivery(delivery)}` : ""}`);
  if (delivery?.kind === "started" && delivery.auto_settle_warning) {
    warn(delivery.auto_settle_warning);
    ctx.exit = 1;
  }
  if (failure !== null) {
    warn(`send: message #${message.id} is stored and unread, but was not delivered (${failure})`);
    ctx.exit = 1;
  }
}

/** `ob inbox <team> <role> [--all] [--json|-q]`, or `--read <id>... --by <run|agent id>`. */
export async function runInbox(ctx: InboxCtx, backend: InboxBackend): Promise<void> {
  const reading = ctx.flags.read !== undefined;
  refuseUnreadFlags("ob inbox", ctx.flags, reading ? ["read", "by"] : ["all"]);
  const { team, role } = teamAndRole("inbox", ctx.args);
  if (reading) {
    const by = ctx.flags.by?.trim();
    if (!by) throw new UsageError("--read needs --by <run|agent id>: who read it");
    const ids = parseMessageIds([String(ctx.flags.read), ...ctx.args.slice(2)]);
    const marked = await backend.read(team, role, ids, by);
    if (ctx.mode === "json") print(JSON.stringify(marked, null, 2));
    else if (ctx.mode === "quiet") print(marked.map((m) => m.id).join("\n"));
    else {
      // A message read before keeps its first reader, so each line names the reader that is stored.
      print(marked.map((m) => (m.read_by === by ? `${team} ${role}: #${m.id} marked read by ${by}` : `${team} ${role}: #${m.id} was already read by ${m.read_by}`)).join("\n"));
    }
    return;
  }
  if (ctx.args.length > 2) throw new UsageError(`inbox takes <team> <role>, got: ${ctx.args.join(" ")}`);
  const messages = await backend.list(team, role, ctx.flags.all === true);
  if (ctx.mode === "json") print(JSON.stringify(messages, null, 2));
  else if (ctx.mode === "quiet") print(messages.map((m) => m.id).join("\n"));
  else if (messages.length === 0) print(`${team} ${role}: no ${ctx.flags.all ? "" : "unread "}messages`);
  else print(messages.map(renderMessage).join("\n"));
}

/** The inbox on this machine's store. */
export function storeInboxBackend(store: Database | Store): InboxBackend {
  return {
    send: (input) => sendRoleMessage(store, input),
    list: (team, role, all) => listRoleMessages(store, team, role, { all }),
    read: (team, role, ids, by) => markRoleMessagesRead(store, team, role, ids, by),
  };
}

export async function cmdSend(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  const inbox = storeInboxBackend(store);
  await runSend(ctx, inbox, (team, role) => deliverToRole(storeRoleBackend(store), inbox, () => t3Seam(), team, role));
}

export async function cmdInbox(ctx: Ctx): Promise<void> {
  await runInbox(ctx, storeInboxBackend(ctx.store ?? ctx.db));
}

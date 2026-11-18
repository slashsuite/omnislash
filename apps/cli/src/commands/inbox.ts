// `ob send <team> <role> "<body>"` and `ob inbox <team> <role>`: a team role's inbox (see ../inbox.ts for the record).
//
// One procedure serves the store and the API client: each passes an `InboxBackend` for the data.
import type { Ctx, Flags } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { listRoleMessages, markRoleMessagesRead, parseMessageIds, sendRoleMessage, type RoleMessage, type RoleMessageInput } from "../inbox.ts";
import { print, type Mode } from "../output.ts";
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
}

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

/** `ob send <team> <role> "<body>" [--body-file <path>] [--from <id>]`. */
export async function runSend(ctx: InboxCtx, backend: InboxBackend): Promise<void> {
  refuseUnreadFlags("ob send", ctx.flags, ["body-file", "from"]);
  const { team, role } = teamAndRole("send", ctx.args);
  const inline = ctx.args.slice(2);
  const fromFile = bodyFromFlags({ "body-file": ctx.flags["body-file"] });
  if (fromFile !== undefined && inline.length > 0) throw new UsageError("pass the message as text or --body-file, not both");
  const body = fromFile ?? inline.join(" ");
  if (!body.trim()) throw new UsageError(`send needs a message: ob send ${team} ${role} "<text>" (or --body-file <path>)`);
  const from = ctx.flags.from?.trim() || DEFAULT_FROM;
  const { message } = await backend.send({ team, role, from, kind: "message", body });
  if (ctx.mode === "json") print(JSON.stringify(message, null, 2));
  else if (ctx.mode === "quiet") print(String(message.id));
  else print(`${team} ${role}: message #${message.id} stored`);
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
    else print(`${team} ${role}: marked ${marked.map((m) => `#${m.id}`).join(", ")} read by ${by}`);
    return;
  }
  if (ctx.args.length > 2) throw new UsageError(`inbox takes <team> <role>, got: ${ctx.args.join(" ")}`);
  const messages = await backend.list(team, role, ctx.flags.all === true);
  if (ctx.mode === "json") print(JSON.stringify(messages, null, 2));
  else if (ctx.mode === "quiet") print(messages.map((m) => m.id).join("\n"));
  else if (messages.length === 0) print(`${team} ${role}: no ${ctx.flags.all ? "" : "unread "}messages`);
  else print(messages.map(renderMessage).join("\n"));
}

function storeBackend(ctx: Ctx): InboxBackend {
  const store = ctx.store ?? ctx.db;
  return {
    send: (input) => sendRoleMessage(store, input),
    list: (team, role, all) => listRoleMessages(store, team, role, { all }),
    read: (team, role, ids, by) => markRoleMessagesRead(store, team, role, ids, by),
  };
}

export async function cmdSend(ctx: Ctx): Promise<void> {
  await runSend(ctx, storeBackend(ctx));
}

export async function cmdInbox(ctx: Ctx): Promise<void> {
  await runInbox(ctx, storeBackend(ctx));
}

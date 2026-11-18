import { type Ctx, emitItem, requireItem } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { clearTriage, triageInbox } from "../items.ts";
import { closeLocally } from "./state.ts";
import { print } from "../output.ts";
import { displayRef } from "../refs.ts";

// ob triage (issue #56): the cross-architect triage inbox. Architects running in OTHER repos hand
// personal/tooling/cross-cutting work over with `ob add --triage`; the OmniSlash architect works the inbox
// here. Bare `ob triage` lists what is awaiting triage; `clear`/`reject` take an item out of the inbox.

/** The body snippet the inbox lists: the first line, ≤57 chars plus '...' when truncated. */
export function triageSnippet(body: string | null): string {
  if (!body) return "";
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

export async function cmdTriage(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];

  if (sub === "clear" || sub === "reject") {
    let id = ctx.args[1];
    if (!id) throw new UsageError(`triage ${sub} requires an <id>`);
    id = (await requireItem(ctx, id)).id;
    // reject closes the item (it will not be worked) through the same door as `ob close` (OB-1928): a
    // validated move on the trail, the GitHub mirror, the spinoff land, and the close clears the flag.
    if (sub === "reject") {
      await closeLocally(ctx, id);
      return;
    }
    // clear keeps it (it has been triaged).
    await clearTriage(ctx.store ?? ctx.db, id);
    await emitItem(ctx, id);
    return;
  }

  if (sub !== undefined) throw new UsageError(`unknown triage subcommand '${sub}'`);

  const items = await triageInbox(ctx.store ?? ctx.db);

  if (ctx.mode === "json") {
    print(
      JSON.stringify(
        items.map((i) => ({
          id: i.id,
          ref: i.ref ?? null,
          title: i.title,
          origin_repo: i.origin_repo,
          note: triageSnippet(i.body),
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (ctx.mode === "quiet") {
    print(items.map(displayRef).join("\n"));
    return;
  }

  if (items.length === 0) {
    print("Triage inbox is empty.");
    return;
  }

  const lines = [`Triage inbox: ${items.length} item(s) awaiting triage`];
  for (const i of items) {
    const from = i.origin_repo ? `  ·from ${i.origin_repo}` : "";
    const note = triageSnippet(i.body);
    lines.push(`  ${displayRef(i)}\t${i.title}${from}${note ? `\t- ${note}` : ""}`);
  }
  print(lines.join("\n"));
}

// One-line banner shown atop `ob next` / `ob status` when the inbox is non-empty (issue #56).
export function triageBanner(count: number): string | null {
  if (count <= 0) return null;
  return `Triage inbox: ${count} item(s) awaiting triage - run \`ob triage\``;
}

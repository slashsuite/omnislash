import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { getItem, getLearningDetail, getLinks, queryItems } from "../items.ts";
import { print } from "../output.ts";

export interface LearningListRow {
  id: string;
  status: string;
  kind: string | null;
  progress: string | null;
  title: string;
}

async function listLearning(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  const items = await queryItems(store, { type: "learning", status: ctx.flags.status });
  items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const rows: LearningListRow[] = await Promise.all(items.map(async (i) => {
    const d = await getLearningDetail(store, i.id);
    return {
      id: i.id,
      status: i.status,
      kind: (d?.kind as string | null) ?? null,
      progress: (d?.progress as string | null) ?? null,
      title: i.title,
    };
  }));

  if (ctx.mode === "json") {
    print(JSON.stringify(rows, null, 2));
    return;
  }
  if (ctx.mode === "quiet") {
    print(rows.map((r) => r.id).join("\n"));
    return;
  }
  print(renderLearningList(rows));
}

async function showLearning(ctx: Ctx, id: string): Promise<void> {
  const store = ctx.store ?? ctx.db;
  const item = await getItem(store, id);
  if (!item) throw new UsageError(`learning '${id}' does not exist`);
  id = item.id;
  if (item.type !== "learning") throw new UsageError(`'${id}' is not a learning item`);
  const detail = await getLearningDetail(store, id);
  const links = await getLinks(store, id);
  const references = links.filter((l) => l.rel_type === "references");

  if (ctx.mode === "json") {
    print(
      JSON.stringify(
        {
          id: item.id,
          title: item.title,
          status: item.status,
          detail,
          references: references.map((r) => ({ direction: r.direction, id: r.other })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (ctx.mode === "quiet") {
    print(id);
    return;
  }

  const lines: string[] = [];
  lines.push(`${item.id}  ${item.title}`);
  lines.push(`  status:   ${item.status}`);
  const field = (label: string, key: string) => {
    const v = detail?.[key];
    if (v !== null && v !== undefined && v !== "") lines.push(`  ${label.padEnd(9)} ${String(v)}`);
  };
  field("kind:", "kind");
  field("progress:", "progress");
  field("source:", "source");
  field("why:", "why");
  for (const r of references) {
    lines.push(`  ref:      ${r.direction === "out" ? "->" : "<-"} ${r.other}`);
  }
  print(lines.join("\n"));
}

export function renderLearningList(rows: LearningListRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.id}\t${r.status.padEnd(11)}\t${(r.kind ?? "-").padEnd(10)}\t${(r.progress ?? "-").padEnd(8)}\t${r.title}`,
    )
    .join("\n");
}

export async function cmdLearning(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === undefined || sub === "list") {
    await listLearning(ctx);
    return;
  }
  await showLearning(ctx, sub);
}

import type { Ctx } from "../ctx.ts";
import { createItem } from "../items.ts";
import { handleMemory } from "../memory.ts";

export async function cmdMemory(ctx: Ctx): Promise<void> {
  await handleMemory(ctx.args, ctx.mode, (fact) =>
    createItem(ctx.store ?? ctx.db, { type: "learning", title: fact }),
  );
}

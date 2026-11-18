import type { Ctx } from "../ctx.ts";
import { print } from "../output.ts";
import { parseCompareRequest, runVisionCompare } from "../vision/compare.ts";

export { expandVisionPairFlags } from "../vision/compare.ts";

export async function cmdVision(ctx: Ctx): Promise<void> {
  const plan = parseCompareRequest({
    args: ctx.args,
    as: ctx.flags.as,
    design: ctx.flags.design,
    on: ctx.flags.on,
    off: ctx.flags.off,
    noEnforce: ctx.flags["no-enforce"] === true,
    json: ctx.mode === "json" || ctx.flags.json === true,
  });
  const result = await runVisionCompare(plan);
  print(plan.json ? JSON.stringify(result.json) : result.text);
  ctx.exit = result.exit;
}

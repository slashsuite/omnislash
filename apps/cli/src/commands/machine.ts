// OS-170: `ob machine audit`, the read-only check of rows against the lifecycle machines.
import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { machineAudit, parseAuditSince, parseStaleDays, renderMachineAudit, type MachineAudit } from "../machine-audit.ts";

export const MACHINE_USAGE = "ob machine audit [--json] [--since <date>] [--stale-days N]";

/** The audit's options from the flags, shared by the local command and the API client. */
export function machineAuditOptions(flags: { since?: string; "stale-days"?: string }): { since?: string; staleDays?: number } {
  const out: { since?: string; staleDays?: number } = {};
  if (flags.since !== undefined) {
    const since = parseAuditSince(flags.since);
    if (since === null) throw new UsageError(`--since must be a date or an ISO time, got '${flags.since}'`);
    out.since = since;
  }
  if (flags["stale-days"] !== undefined) {
    const days = parseStaleDays(flags["stale-days"]);
    if (days === null) throw new UsageError(`--stale-days must be a whole number of days, got '${flags["stale-days"]}'`);
    out.staleDays = days;
  }
  return out;
}

/** Print the audit. `--json` prints `{unresolvable, stale, wouldRefuse}`. Exit 0 whatever it finds. */
export function printMachineAudit(audit: MachineAudit, mode: Ctx["mode"]): void {
  if (mode === "json") print(JSON.stringify(audit, null, 2));
  else print(renderMachineAudit(audit));
}

export async function cmdMachine(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub !== "audit") throw new UsageError(`unknown machine subcommand '${sub ?? ""}' (audit)\n${MACHINE_USAGE}`);
  const audit = await machineAudit(ctx.store, machineAuditOptions(ctx.flags));
  printMachineAudit(audit, ctx.mode);
}

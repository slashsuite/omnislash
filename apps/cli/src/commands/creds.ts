import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { sqliteStoreFor } from "../db/store.ts";
import { print, type Mode } from "../output.ts";
import {
  credentialInventory,
  CREDENTIAL_NAMES,
  runCredentialCheck,
  type CredentialCheckRow,
  type CredentialStatus,
} from "../credentials.ts";

// -----------------------------------------------------------------------------
// `ob creds` (219): the credential inventory the dashboard's tokens page renders, on the terminal.
//   creds             every credential ob depends on: is it there, when was it last checked, how is it
//                     refreshed. Reads only -- no provider is called.
//   creds check <name> | creds check --all
//                     run the live check(s) and record the verdict. The ONLY path here that leaves the
//                     machine, and it runs because a person asked, the daily creds-check job (`--all`, 1655)
//                     does, or a skeptical review's out-of-credits rule and the architect's owed-review pass
//                     ask it about the OpenCode plan (OB-1850). Exits 1 when any verdict is FAILED and names which.
// A VALUE is never printed by either.
// -----------------------------------------------------------------------------

function line(s: CredentialStatus): string {
  const presence = s.present ? "present" : "MISSING";
  const check = s.last_check
    ? `${s.last_check.ok ? "ok" : "FAILED"} @ ${s.last_check.checked_at}${s.last_check.detail ? ` (${s.last_check.detail})` : ""}`
    : "never checked";
  return `${s.name.padEnd(22)} ${presence.padEnd(8)} ${s.presence_detail}\n${" ".repeat(22)} check: ${check}\n${" ".repeat(22)} refresh: ${s.command}`;
}

// The renderers are pure and exported (357) so the API client renders the SAME text from the SAME rows.
// A second copy on the client is how two paths start describing one credential store differently, which
// is the whole failure `ob` keeps paying for.

export function renderCredentialInventory(inventory: CredentialStatus[], mode: Mode): string {
  if (mode === "json") return JSON.stringify(inventory, null, 2);
  if (mode === "quiet") return inventory.map((s) => `${s.name}\t${s.present ? "present" : "missing"}`).join("\n");
  const parts = [inventory.map(line).join("\n\n")];
  const missing = inventory.filter((s) => !s.present);
  if (missing.length > 0) parts.push(`\n${missing.length} missing: ${missing.map((s) => s.name).join(", ")}`);
  parts.push("\nValidity is only as fresh as the last check. `ob creds check --all` asks the providers.");
  return parts.join("\n");
}

export function renderCredentialChecks(rows: CredentialCheckRow[], mode: Mode): string {
  if (mode === "json") return JSON.stringify(rows, null, 2);
  if (mode === "quiet") return rows.map((r) => `${r.name}\t${r.ok ? "ok" : "failed"}`).join("\n");
  return rows.map((r) => `${r.name.padEnd(22)} ${(r.ok ? "ok" : "FAILED").padEnd(8)} ${r.detail ?? ""}`).join("\n");
}

/** The line that NAMES the credentials that failed, so a journal or an OnFailure ticket says which (1655). */
export function failedChecks(rows: CredentialCheckRow[], mode: Mode): string | null {
  const failed = rows.filter((r) => !r.ok).map((r) => r.name);
  if (failed.length === 0 || mode === "json" || mode === "quiet") return null;
  return `\n${failed.length} of ${rows.length} FAILED: ${failed.join(", ")}`;
}

export async function cmdCreds(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];

  if (sub === "check") {
    const name = ctx.args[1];
    const all = ctx.flags.all === true;
    if (!name && !all) throw new UsageError(`creds check requires a <name> (${CREDENTIAL_NAMES.join("|")}) or --all`);
    const store = ctx.store ?? sqliteStoreFor(ctx.db);
    const targets = all
      ? (await credentialInventory(store)).filter((c) => c.checkable).map((c) => c.name)
      : [name!];
    const rows = [];
    for (const target of targets) rows.push(await runCredentialCheck(store, target, { http: ctx.credsFetch }));
    print(renderCredentialChecks(rows, ctx.mode));
    // 1655: a failed verdict is a failure for the caller too, so the daily creds-check job is a JOB
    // FAILING alert (218) instead of an exit-0 line in a journal nobody reads. Every row is recorded first.
    const failed = failedChecks(rows, ctx.mode);
    if (failed) print(failed);
    if (rows.some((r) => !r.ok)) ctx.exit = 1;
    return;
  }

  if (sub !== undefined) throw new UsageError(`unknown creds subcommand '${sub}' (check)`);

  const inventory = await credentialInventory(ctx.store ?? sqliteStoreFor(ctx.db));
  print(renderCredentialInventory(inventory, ctx.mode));
}

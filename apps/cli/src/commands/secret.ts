import { readFileSync } from "node:fs";
import type { Ctx } from "../ctx.ts";
import { UsageError, AppError } from "../errors.ts";
import { print, printRaw, type Mode } from "../output.ts";
import { expandHome } from "../net.ts";
import { settingFor } from "../settings.ts";
import { sqliteStoreFor, type Store } from "../db/store.ts";
import {
  clearCredentialCheck,
  defaultMasterKey,
  masterKeyForWrite,
  getSecret,
  hasSecret,
  KNOWN_SECRETS,
  listSecrets,
  type MasterKey,
  removeSecret,
  setSecret,
} from "../secrets.ts";

// -----------------------------------------------------------------------------
// `ob secret` (135): manage the encrypted secret store.
//   set <name>   value from STDIN (never argv — no shell history)
//   get <name>   decrypt → stdout (the ONLY intentional value-retrieval path)
//   list         names + updated_at ONLY (never values)
//   rm <name>
//   import       copy each known token FILE → the store (idempotent; never deletes the file)
// -----------------------------------------------------------------------------

export interface ImportResult {
  name: string;
  action: "imported" | "exists" | "absent";
  path: string;
}

/**
 * For each known secret, if the store lacks it and its `*_path` FILE exists, read the file → store it.
 * Idempotent (already-stored → "exists"; no file → "absent"). Never deletes the source file — the
 * architect deletes the plaintext files after verifying the migration.
 */
export async function importSecrets(store: Store, masterKey: MasterKey): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  for (const [name, spec] of Object.entries(KNOWN_SECRETS)) {
    const path = await settingFor(store, spec.pathSetting);
    if (await hasSecret(store, name)) {
      results.push({ name, action: "exists", path });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(expandHome(path), "utf8").trim();
    } catch {
      results.push({ name, action: "absent", path });
      continue;
    }
    await setSecret(store, name, text, masterKey.get());
    results.push({ name, action: "imported", path });
  }
  return results;
}

async function readStdin(): Promise<string> {
  return (await Bun.stdin.text()).trim();
}

/**
 * The listing, rendered once (357) so the API client prints exactly what the local command prints.
 *
 * It takes rows of `{ name, updated_at }` and there is no third field it could reach for: the shape it
 * renders is the shape `listSecrets` selects, which selects no ciphertext column at all.
 */
export function renderSecretList(rows: Array<{ name: string; updated_at: string }>, mode: Mode): string {
  if (mode === "json") return JSON.stringify(rows, null, 2);
  if (mode === "quiet") return rows.map((r) => r.name).join("\n");
  if (rows.length === 0) return "(no secrets stored — `ob secret set <name>` or `ob secret import`)";
  return rows.map((r) => `${r.name}\t${r.updated_at}`).join("\n");
}

export async function cmdSecret(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  // Every path below reads and writes through the store, so `ob secret` is servable from Postgres.
  const store = ctx.store ?? sqliteStoreFor(ctx.db);

  if (sub === "set") {
    const name = ctx.args[1];
    if (!name) throw new UsageError("secret set requires a <name> (value is read from stdin)");
    const value = await readStdin();
    if (!value) throw new UsageError("secret set: no value on stdin (pipe the value in, e.g. `pbpaste | ob secret set <name>`)");
    await setSecret(store, name, value, (await masterKeyForWrite(store)).get());
    await clearCredentialCheck(store, name);
    if (ctx.mode === "json") print(JSON.stringify({ name, set: true }));
    else if (ctx.mode !== "quiet") print(`set secret \`${name}\``);
    return;
  }

  if (sub === "get") {
    const name = ctx.args[1];
    if (!name) throw new UsageError("secret get requires a <name>");
    const value = await getSecret(store, name, defaultMasterKey().get());
    if (value === null) throw new AppError(`no secret \`${name}\` in the store`);
    // The one intentional value-retrieval path — write the decrypted value verbatim to stdout.
    printRaw(`${value}\n`);
    return;
  }

  if (sub === "list") {
    const rows = await listSecrets(store); // names + updated_at ONLY — never a value
    print(renderSecretList(rows, ctx.mode));
    return;
  }

  if (sub === "rm") {
    const name = ctx.args[1];
    if (!name) throw new UsageError("secret rm requires a <name>");
    const existed = await removeSecret(store, name);
    if (!existed) throw new AppError(`no secret \`${name}\` in the store`);
    await clearCredentialCheck(store, name);
    if (ctx.mode === "json") print(JSON.stringify({ name, removed: true }));
    else if (ctx.mode !== "quiet") print(`removed secret \`${name}\``);
    return;
  }

  if (sub === "import") {
    const results = await importSecrets(store, await masterKeyForWrite(store));
    if (ctx.mode === "json") {
      print(JSON.stringify(results, null, 2));
      return;
    }
    const imported = results.filter((r) => r.action === "imported");
    for (const r of results) {
      const note =
        r.action === "imported" ? `imported from ${r.path}` : r.action === "exists" ? "already in store (skipped)" : `no file at ${r.path} (skipped)`;
      print(`${r.name}\t${note}`);
    }
    if (imported.length > 0) {
      print(`\nimported ${imported.length} secret(s). The plaintext file(s) are left in place — delete them once you've verified.`);
    }
    return;
  }

  throw new UsageError(`unknown secret subcommand '${sub ?? ""}' (set|get|list|rm|import)`);
}
